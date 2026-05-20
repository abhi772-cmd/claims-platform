// Demo-data seeder for the compliance dashboard (Slice BU).
//
// Idempotent: re-running adds another batch (each run uses fresh
// uuids); pre-existing rows from earlier runs stay. The canonical
// per-PR seed lives in seed.ts and creates the dev tenant + admin
// user — run that first, then this for visual data.
//
// What gets created (all under tenant slug=digisparsh-dev):
//   - 3 patients
//   - 6 consent records (4 granted, 1 withdrawn, 1 expired)
//   - 14 data_access_event rows (mix of bound + unbound; some
//     unbound in past 24h to bump the dashboard's
//     unboundAccessCountLast24h triage signal)
//   - 3 erasure requests (2 completed, 1 rejected with blocking claims)
//   - 3 breach_incident rows (1 OVERDUE past 72h, 1 still-in-window
//     detected, 1 already-notified)
//   - audit_log rows across financial / clinical / governance / security
//     retention classes
//
// Run via:  pnpm --filter @claims/api db:seed:demo

import { Prisma, PrismaClient } from '@prisma/client';

const TENANT_SLUG = 'digisparsh-dev';
const ADMIN_EMAIL = 'abhijeet.sharma@digisparsh.in';

async function seedDemo(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );

      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { slug: TENANT_SLUG },
        select: { id: true },
      });
      const admin = await tx.user.findUniqueOrThrow({
        where: { email: ADMIN_EMAIL },
        select: { id: true },
      });
      const tenantId = tenant.id;
      const actorUserId = admin.id;

      // Set tenant_id GUC for the rest of the seed so RLS-FORCEd
      // tables accept INSERT against this tenant.
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
      );

      // 1. Patients ------------------------------------------------
      const patientNames = [
        ['Anita Kapoor', '+91-98xxxx0001'],
        ['Rohan Mehta', '+91-98xxxx0002'],
        ['Priya Singh', '+91-98xxxx0003'],
      ];
      const patientIds: string[] = [];
      for (const [name, mobileLabel] of patientNames) {
        const p = await tx.patient.create({
          data: {
            tenantId,
            fullName: name,
            dateOfBirth: new Date('1985-06-15'),
            gender: 'female',
            // Placeholder ciphertext + key version. Real ciphers come
            // from PatientService.buildCreatePayload — for visual
            // demo purposes the column being non-null is enough for
            // the dashboard's "field touched" list to populate.
            aadhaarCipher: `cipher-aadhaar-${name}`,
            aadhaarKeyVersion: 'v1',
            mobileCipher: `cipher-mobile-${mobileLabel}`,
            mobileKeyVersion: 'v1',
          },
          select: { id: true },
        });
        patientIds.push(p.id);
      }

      // 2. Consent records -----------------------------------------
      const consentRows: Array<{ id: string; patientId: string; status: string }> = [];
      // Helper to land a consent in the desired final state. We
      // create it as 'granted', then UPDATE it to 'withdrawn' /
      // 'expired' if needed, so RLS UPDATE policy is exercised.
      const grantConsent = async (
        patientId: string,
        consentType: string,
        finalStatus: 'granted' | 'withdrawn' | 'expired',
        opts: { expiresInDays?: number; withdrawalReason?: string } = {},
      ): Promise<string> => {
        const c = await tx.consentRecord.create({
          data: {
            tenantId,
            patientId,
            consentType,
            dataCategories: ['aadhaar', 'mobile'],
            purposes: ['eligibility.verify', 'preauth.submit'],
            lawfulBasis: 'consent',
            status: 'granted',
            source: 'in_person',
            evidence: {
              noticeText:
                'You authorise the hospital to share your data with NHCX participants for claims processing.',
              acknowledgedVia: 'in_person_signature',
              locales: ['en-IN'],
            },
            capturedByUserId: actorUserId,
            ...(opts.expiresInDays !== undefined
              ? {
                  expiresAt: new Date(
                    Date.now() + opts.expiresInDays * 24 * 60 * 60 * 1000,
                  ),
                }
              : {}),
          },
          select: { id: true },
        });
        if (finalStatus === 'withdrawn') {
          await tx.consentRecord.update({
            where: { id: c.id },
            data: {
              status: 'withdrawn',
              withdrawnAt: new Date(),
              withdrawalReason:
                opts.withdrawalReason ??
                'Patient requested withdrawal at follow-up visit.',
            },
          });
        } else if (finalStatus === 'expired') {
          await tx.consentRecord.update({
            where: { id: c.id },
            data: { status: 'expired' },
          });
        }
        consentRows.push({ id: c.id, patientId, status: finalStatus });
        return c.id;
      };

      const consentP0Nhcx = await grantConsent(patientIds[0]!, 'nhcx_processing', 'granted', {
        expiresInDays: 365,
      });
      await grantConsent(patientIds[0]!, 'communication', 'granted');
      const consentP1Nhcx = await grantConsent(patientIds[1]!, 'nhcx_processing', 'granted');
      await grantConsent(patientIds[1]!, 'analytics', 'withdrawn', {
        withdrawalReason:
          'Patient opted out of analytics processing during follow-up call.',
      });
      const consentP2Pmjay = await grantConsent(patientIds[2]!, 'pmjay_processing', 'granted');
      await grantConsent(patientIds[2]!, 'communication', 'expired');

      // 3. Data access events --------------------------------------
      // Mix of bound (have consentGrantId) + unbound (null). Most
      // unbound rows go in the past 24h so the dashboard's
      // "unboundAccessCountLast24h" triage signal is non-zero.
      const decryptEvents: Array<{
        patientIdx: number;
        consentGrantId: string | null;
        purpose: string;
        minutesAgo: number;
      }> = [
        { patientIdx: 0, consentGrantId: consentP0Nhcx, purpose: 'eligibility.verify', minutesAgo: 5 },
        { patientIdx: 0, consentGrantId: consentP0Nhcx, purpose: 'preauth.submit', minutesAgo: 12 },
        { patientIdx: 0, consentGrantId: consentP0Nhcx, purpose: 'preauth.submit', minutesAgo: 22 },
        { patientIdx: 1, consentGrantId: consentP1Nhcx, purpose: 'eligibility.verify', minutesAgo: 30 },
        { patientIdx: 1, consentGrantId: consentP1Nhcx, purpose: 'claim.submit', minutesAgo: 60 },
        { patientIdx: 2, consentGrantId: consentP2Pmjay, purpose: 'preauth.submit', minutesAgo: 90 },
        { patientIdx: 2, consentGrantId: consentP2Pmjay, purpose: 'claim.submit', minutesAgo: 120 },
        // Unbound — 5 reads in the past 24h that no caller has
        // wired to a consent. These bump unboundAccessCountLast24h.
        { patientIdx: 0, consentGrantId: null, purpose: 'manual_view', minutesAgo: 8 },
        { patientIdx: 0, consentGrantId: null, purpose: 'manual_view', minutesAgo: 17 },
        { patientIdx: 1, consentGrantId: null, purpose: 'audit_query', minutesAgo: 45 },
        { patientIdx: 1, consentGrantId: null, purpose: 'audit_query', minutesAgo: 200 },
        { patientIdx: 2, consentGrantId: null, purpose: 'audit_query', minutesAgo: 720 },
        // Older bound rows so the recent list isn't 100% fresh.
        { patientIdx: 0, consentGrantId: consentP0Nhcx, purpose: 'eligibility.verify', minutesAgo: 600 },
        { patientIdx: 1, consentGrantId: consentP1Nhcx, purpose: 'preauth.submit', minutesAgo: 900 },
      ];
      for (const e of decryptEvents) {
        const occurredAt = new Date(Date.now() - e.minutesAgo * 60 * 1000);
        await tx.dataAccessEvent.create({
          data: {
            tenantId,
            actorUserId,
            actorType: 'user',
            resourceType: 'patient',
            resourceId: patientIds[e.patientIdx]!,
            action: 'decrypt',
            purpose: e.purpose,
            fieldNames: ['aadhaar', 'mobile'],
            consentGrantId: e.consentGrantId,
            occurredAt,
          },
        });
      }

      // 4. Erasure requests ----------------------------------------
      // Two completed (no blocking claims) + one rejected with a
      // synthetic blockingClaims list so the BU "blocking claims"
      // count column shows non-zero.
      await tx.erasureRequest.create({
        data: {
          tenantId,
          patientId: patientIds[0]!,
          requestedBy: 'Front desk: ABHA matched 91-XXXX-1234',
          reason: 'DPDP §11 erasure request from data principal.',
          status: 'completed',
          affectedCounts: { patient: 1, case: 0 },
          processedByUserId: actorUserId,
          completedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        },
      });
      await tx.erasureRequest.create({
        data: {
          tenantId,
          patientId: patientIds[1]!,
          requestedBy: 'Email: dpo-request-7842@example.in',
          reason: 'Withdrawal of NHCX processing consent.',
          status: 'completed',
          affectedCounts: { patient: 1, case: 1 },
          processedByUserId: actorUserId,
          completedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        },
      });
      await tx.erasureRequest.create({
        data: {
          tenantId,
          patientId: patientIds[2]!,
          requestedBy: 'Walk-in: photo ID match (Aadhaar 12xx-xxxx-3456)',
          reason: 'DPDP §11 — patient requested removal.',
          status: 'rejected',
          rejectionReason: {
            blockingClaims: [
              { id: '11111111-2222-3333-4444-555555555555', status: 'PREAUTH_QUEUED' },
              { id: '22222222-3333-4444-5555-666666666666', status: 'CLAIM_SUBMITTED' },
            ],
          },
          processedByUserId: actorUserId,
          completedAt: new Date(),
        },
      });

      // 5. Breach incidents ----------------------------------------
      // One OVERDUE (dpdpNotificationDueAt in the past) drives the
      // red banner; one still-in-window detected; one notified.
      await tx.breachIncident.create({
        data: {
          tenantId,
          kind: 'BURST_DECRYPT',
          severity: 'high',
          status: 'detected',
          actorUserId,
          affectedDataPrincipals: 73,
          dataCategories: ['aadhaar', 'mobile'],
          description:
            'BURST_DECRYPT detected: actor decrypted 73 distinct patients between 14:00-15:00 IST. Threshold: 50/60m.',
          evidenceEventIds: [],
          windowStart: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
          windowEnd: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000),
          openedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
          dpdpNotificationDueAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // OVERDUE
        },
      });
      await tx.breachIncident.create({
        data: {
          tenantId,
          kind: 'MANUAL_REPORT',
          severity: 'medium',
          status: 'detected',
          affectedDataPrincipals: 4,
          dataCategories: ['mobile'],
          description:
            'Operator reported potential mis-routed export — investigation in progress.',
          evidenceEventIds: [],
          openedAt: new Date(Date.now() - 12 * 60 * 60 * 1000),
          dpdpNotificationDueAt: new Date(Date.now() + 60 * 60 * 60 * 1000),
        },
      });
      await tx.breachIncident.create({
        data: {
          tenantId,
          kind: 'MANUAL_REPORT',
          severity: 'critical',
          status: 'notified',
          affectedDataPrincipals: 22,
          dataCategories: ['aadhaar', 'mobile', 'email'],
          description: 'Lost laptop reported by clinical reviewer; encrypted but reported to DPB.',
          evidenceEventIds: [],
          openedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
          dpdpNotificationDueAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
          dpdpNotificationSentAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
          dpdpNotificationPayload: {
            subject: '[DPDP §8(6) — CRITICAL] Lost device incident',
            body: 'Notification text snapshot retained at notify-time.',
            fields: { severity: 'critical' },
          },
          processedByUserId: actorUserId,
        },
      });

      // 6. Audit log rows across retention classes -----------------
      // The login flow already creates session-class rows. Add a
      // few in financial / clinical / governance / security so the
      // dashboard's retention table renders non-zero across the
      // board.
      const auditSpread: Array<{ action: string; cls: string; daysAgo: number; resourceType: string }> = [
        { action: 'CLAIM_SUBMITTED', cls: 'financial', daysAgo: 3, resourceType: 'claim' },
        { action: 'SETTLEMENT_RECORDED', cls: 'financial', daysAgo: 5, resourceType: 'settlement' },
        { action: 'PREAUTH_APPROVED', cls: 'clinical', daysAgo: 1, resourceType: 'preauth' },
        { action: 'DOCTOR_SIGNED', cls: 'clinical', daysAgo: 2, resourceType: 'preauth' },
        { action: 'TENANT_NHCX_CONFIGURED', cls: 'governance', daysAgo: 10, resourceType: 'tenant' },
        { action: 'USER_LOCKED', cls: 'security', daysAgo: 4, resourceType: 'user' },
      ];
      for (const a of auditSpread) {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "audit_log"
            ("id", "tenantId", "occurredAt", "actorType", "action", "resourceType", "after", "retentionClass")
          VALUES (
            gen_random_uuid(),
            ${tenantId}::uuid,
            now() - make_interval(days => ${a.daysAgo}::int),
            'user',
            ${a.action},
            ${a.resourceType},
            ${JSON.stringify({ note: 'demo seed' })}::jsonb,
            ${a.cls}
          )
        `);
      }

      // 7. Room rate catalog + per-payer commercial terms ---------
      // Demo data for the room dropdown on /cases/new and the
      // out-of-pocket pre-warn. Uses upsert so the seed stays
      // idempotent — re-running won't trip the (tenantId, code) /
      // (tenantId, payerCode) unique constraints.

      const roomCategorySeeds: Array<{
        code: string;
        name: string;
        category: string;
        dailyRateRupees: number;
        sortOrder: number;
      }> = [
        {
          code: 'GENERAL_WARD',
          name: 'General ward',
          category: 'ward',
          dailyRateRupees: 5000,
          sortOrder: 10,
        },
        {
          code: 'SEMI_PRIVATE',
          name: 'Semi-private',
          category: 'semi-private',
          dailyRateRupees: 8000,
          sortOrder: 20,
        },
        {
          code: 'PRIVATE',
          name: 'Private room',
          category: 'private',
          dailyRateRupees: 12000,
          sortOrder: 30,
        },
        {
          code: 'ICU',
          name: 'Intensive care',
          category: 'icu',
          dailyRateRupees: 25000,
          sortOrder: 40,
        },
      ];

      const categoryIdsByCode = new Map<string, string>();
      for (const c of roomCategorySeeds) {
        const row = await tx.roomCategory.upsert({
          where: { tenantId_code: { tenantId, code: c.code } },
          create: {
            tenantId,
            code: c.code,
            name: c.name,
            category: c.category,
            dailyRatePaise: c.dailyRateRupees * 100,
            sortOrder: c.sortOrder,
          },
          update: {
            name: c.name,
            category: c.category,
            dailyRatePaise: c.dailyRateRupees * 100,
            sortOrder: c.sortOrder,
            active: true,
          },
          select: { id: true },
        });
        categoryIdsByCode.set(c.code, row.id);
      }

      // Per-payer rate overrides — STAR_HEALTH + HDFC_ERGO on the
      // higher-tier categories (private + ICU). Wards rarely get
      // negotiated separately.
      const overrideSeeds: Array<{
        payerCode: string;
        roomCode: string;
        dailyRateRupees: number;
      }> = [
        { payerCode: 'STAR_HEALTH', roomCode: 'PRIVATE', dailyRateRupees: 9500 },
        { payerCode: 'STAR_HEALTH', roomCode: 'ICU', dailyRateRupees: 22500 },
        { payerCode: 'HDFC_ERGO', roomCode: 'PRIVATE', dailyRateRupees: 10200 },
        { payerCode: 'HDFC_ERGO', roomCode: 'ICU', dailyRateRupees: 23000 },
      ];

      for (const o of overrideSeeds) {
        const roomCategoryId = categoryIdsByCode.get(o.roomCode);
        if (!roomCategoryId) continue;
        await tx.roomCategoryPayerRate.upsert({
          where: {
            tenantId_roomCategoryId_payerCode: {
              tenantId,
              roomCategoryId,
              payerCode: o.payerCode,
            },
          },
          create: {
            tenantId,
            roomCategoryId,
            payerCode: o.payerCode,
            dailyRatePaise: o.dailyRateRupees * 100,
          },
          update: {
            dailyRatePaise: o.dailyRateRupees * 100,
            active: true,
          },
        });
      }

      // Commercial terms — co-pay + deductible (mandatory) plus a
      // mix of recommended fields populated to show the form's
      // breadth in the admin UI.
      const termsSeeds: Array<{
        payerCode: string;
        copayPercent: number;
        deductibleRupees: number;
        preauthTatMinutes: number;
        paymentTermDays: number;
        flatDiscountPercent: number;
        networkCategory: string;
      }> = [
        {
          payerCode: 'STAR_HEALTH',
          copayPercent: 10,
          deductibleRupees: 5000,
          preauthTatMinutes: 240,
          paymentTermDays: 30,
          flatDiscountPercent: 15,
          networkCategory: 'Preferred',
        },
        {
          payerCode: 'HDFC_ERGO',
          copayPercent: 15,
          deductibleRupees: 7500,
          preauthTatMinutes: 180,
          paymentTermDays: 45,
          flatDiscountPercent: 12,
          networkCategory: 'Platinum',
        },
      ];

      for (const t of termsSeeds) {
        await tx.payerCommercialTerms.upsert({
          where: {
            tenantId_payerCode: { tenantId, payerCode: t.payerCode },
          },
          create: {
            tenantId,
            payerCode: t.payerCode,
            copayPercent: t.copayPercent,
            copayAppliesTo: 'both',
            deductiblePaise: t.deductibleRupees * 100,
            deductibleScope: 'per_admission',
            effectiveFrom: new Date('2026-01-01'),
            effectiveTo: new Date('2027-12-31'),
            signedOn: new Date('2025-12-15'),
            signatoryName: 'A. Mehta, Director of Operations',
            noticePeriodDays: 90,
            preauthTatMinutes: t.preauthTatMinutes,
            claimTatMinutes: 720,
            paymentTermDays: t.paymentTermDays,
            paymentMode: 'neft',
            tdsPercent: 2,
            flatDiscountPercent: t.flatDiscountPercent,
            networkCategory: t.networkCategory,
            nabhRequired: true,
            empanelledSpecialties: ['cardiology', 'oncology', 'orthopaedics'],
          },
          update: {
            copayPercent: t.copayPercent,
            deductiblePaise: t.deductibleRupees * 100,
            preauthTatMinutes: t.preauthTatMinutes,
            paymentTermDays: t.paymentTermDays,
            flatDiscountPercent: t.flatDiscountPercent,
            networkCategory: t.networkCategory,
            active: true,
          },
        });
      }

      console.log(
        `Demo seed complete. tenant=${TENANT_SLUG} patients=${patientIds.length} consents=${consentRows.length} decryptEvents=${decryptEvents.length} erasures=3 breaches=3 audit=${auditSpread.length} roomCategories=${roomCategorySeeds.length} payerRateOverrides=${overrideSeeds.length} commercialTerms=${termsSeeds.length}`,
      );
    });
  } finally {
    await prisma.$disconnect();
  }
}

void seedDemo().catch((err) => {
  console.error(err);
  process.exit(1);
});
