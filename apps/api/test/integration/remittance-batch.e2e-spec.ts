// Slice AL integration test — payer remittance batch reconciliation.
//
// Drives three claims through to PAYMENT_PENDING, captures their
// claimRefNums, then POSTs a remittance batch with a mix of
//   - matching rows (full amount → PAYMENT_RECEIVED, manual_match_pending)
//   - matching rows (short amount → PAYMENT_RECEIVED + SHORT_PAID)
//   - rows with unknown claimRefNum (unmatched_no_claim)
//   - rows for a claim that exists but has no settlement (unmatched_no_settlement)
// Asserts:
//   1. Per-row outcomes line up.
//   2. Counts in the response are correct.
//   3. Applied rows actually drove the claim's status forward.
//   4. RBAC: a reader without settlement.upload_eob → 403.

import { generateKeyPairSync } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { argon2id, hash } from 'argon2';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { startPostgres, type PgHandles } from '../setup/postgres-container';

jest.setTimeout(180_000);

async function readClaim(
  prisma: PrismaClient,
  claimId: string,
): Promise<{ status: string; paidAmount: number | null } | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
    );
    return tx.claim.findUnique({
      where: { id: claimId },
      select: { status: true, paidAmount: true },
    });
  });
}

async function readSettlement(
  prisma: PrismaClient,
  claimId: string,
): Promise<{ bankTxnId: string | null; reconciliationStatus: string } | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
    );
    return tx.settlement.findUnique({
      where: { claimId },
      select: { bankTxnId: true, reconciliationStatus: true },
    });
  });
}

describe('Slice AL — payer remittance batch', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN = 'admin-rb@rb-test.local';
  const READER = 'reader-rb@rb-test.local';

  beforeAll(async () => {
    pg = await startPostgres();
    migrator = new PrismaClient({ datasources: { db: { url: pg.migratorUrl } } });

    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'api';
    process.env['PORT'] = '0';
    process.env['DATABASE_URL'] = pg.appUrl;
    process.env['DATABASE_URL_MIGRATOR'] = pg.migratorUrl;
    process.env['JWT_PRIVATE_KEY_BASE64'] = Buffer.from(
      privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    ).toString('base64');
    process.env['JWT_PUBLIC_KEY_BASE64'] = Buffer.from(
      publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    ).toString('base64');
    process.env['LOG_LEVEL'] = 'warn';
    process.env['CORS_ORIGIN'] = 'http://localhost:3000';
    process.env['WEB_BASE_URL'] = 'http://localhost:3000';
    process.env['SMTP_HOST'] = '127.0.0.1';
    process.env['SMTP_PORT'] = '1';
    process.env['SMTP_FROM'] = 'no-reply@test';
    process.env['NHCX_STUB_VERIFY_DEFAULT'] = 'true';
    process.env['NOTIFICATION_RETRY_DISABLED'] = 'true';
    process.env['DOC_LIFECYCLE_DISABLED'] = 'true';

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const tenant = await tx.tenant.create({
        data: { slug: 'tenant-rb', displayName: 'Remit Batch', lifecycleState: 'IN_SETUP' },
      });
      const adminRole = await tx.role.create({
        data: {
          tenantId: tenant.id,
          name: 'tenant_admin',
          permissions: [
            'case.create',
            'case.view',
            'case.assign',
            'preauth.draft',
            'preauth.submit',
            'preauth.approve_internal',
            'claim.draft',
            'claim.submit',
            'settlement.upload_eob',
            'settlement.categorize_deduct',
          ],
        },
      });
      const readerRole = await tx.role.create({
        data: {
          tenantId: tenant.id,
          name: 'reader',
          permissions: ['case.view'],
        },
      });
      const a = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: ADMIN,
          passwordHash,
          firstName: 'RB',
          lastName: 'Admin',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tenant.id, userId: a.id, roleId: adminRole.id },
      });
      const r = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: READER,
          passwordHash,
          firstName: 'RB',
          lastName: 'Reader',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tenant.id, userId: r.id, roleId: readerRole.id },
      });
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.use(cookieParser());
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await migrator.$disconnect().catch(() => undefined);
    await pg?.shutdown();
  });

  async function loginAs(email: string): Promise<string[]> {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
    const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
    return (Array.isArray(raw) ? raw : raw ? [raw] : [])
      .map((c) => c.split(';')[0])
      .filter((c): c is string => Boolean(c));
  }

  // Drive a fresh case to PAYMENT_PENDING and return its (caseId,
  // claimId, claimRefNum). The claimRefNum gets stamped on the claim
  // by ClaimSubmitService at the QUEUED transition.
  async function caseAtPaymentPending(
    cookies: string[],
    mrn: string,
    finalAmount: number,
    skipExpect = false,
  ): Promise<{ caseId: string; claimId: string; claimRefNum: string }> {
    const create = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'Patient',
        hospitalMrn: mrn,
        admissionDate: '2026-05-01',
        admissionType: 'planned',
        primaryRail: 'nhcx',
      });
    const caseId = create.body.id as string;
    const claimId = create.body.claims[0].id as string;
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/eligibility`)
      .set('Cookie', cookies)
      .send({});
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/transitions`)
      .set('Cookie', cookies)
      .send({ eventType: 'preauth.drafting_started' });
    await request(app.getHttpServer())
      .put(`/cases/${caseId}/claims/${claimId}/preauth/draft`)
      .set('Cookie', cookies)
      .send({
        diagnosisDescription: 'Acute MI',
        plannedProcedure: 'CABG',
        requestedAmount: finalAmount,
      });
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/submit`)
      .set('Cookie', cookies)
      .send({});
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/decision`)
      .set('Cookie', cookies)
      .send({ kind: 'approved', approvedAmount: finalAmount });
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/discharge/initiate`)
      .set('Cookie', cookies)
      .send({});
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/documents/upload-stub`)
      .set('Cookie', cookies)
      .send({
        documentType: 'discharge_summary',
        originalFilename: 'd.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1024,
      });
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/discharge/submit`)
      .set('Cookie', cookies)
      .send({});
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/claim-submission/start`)
      .set('Cookie', cookies)
      .send({});
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/claim-submission/submit`)
      .set('Cookie', cookies)
      .send({ finalAmount });
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/claim-submission/decision`)
      .set('Cookie', cookies)
      .send({ kind: 'approved', approvedAmount: finalAmount });
    if (!skipExpect) {
      await request(app.getHttpServer())
        .post(`/cases/${caseId}/claims/${claimId}/settlement/expect`)
        .set('Cookie', cookies)
        .send({ paymentMode: 'cashless_tpa' });
    }

    // Pull claimRefNum from the migrator (we stamped it via the stub
    // adapter response).
    const claim = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      return tx.claim.findUniqueOrThrow({
        where: { id: claimId },
        select: { claimRefNum: true },
      });
    });
    expect(claim.claimRefNum).toBeTruthy();
    return { caseId, claimId, claimRefNum: claim.claimRefNum! };
  }

  it('mixed batch: applied + short-paid + unmatched + no-settlement', async () => {
    const cookies = await loginAs(ADMIN);

    const c1 = await caseAtPaymentPending(cookies, 'MRN-RB-1', 100_000);
    const c2 = await caseAtPaymentPending(cookies, 'MRN-RB-2', 200_000);
    // c3 doesn't have a settlement open (skipExpect=true).
    const c3 = await caseAtPaymentPending(cookies, 'MRN-RB-3', 50_000, true);

    const res = await request(app.getHttpServer())
      .post('/settlement/remittance')
      .set('Cookie', cookies)
      .send({
        rows: [
          // Match c1 with full amount → applied + manual_match_pending.
          { claimRefNum: c1.claimRefNum, receivedAmount: 100_000 },
          // Match c2 with partial amount → applied + short_paid.
          {
            claimRefNum: c2.claimRefNum,
            receivedAmount: 150_000,
            shortPaymentReasons: ['Cap exceeded under rider B'],
            bankTxnId: 'BANK-9001',
          },
          // c3 has a claim but no settlement → unmatched_no_settlement.
          { claimRefNum: c3.claimRefNum, receivedAmount: 50_000 },
          // Unknown ref → unmatched_no_claim.
          { claimRefNum: 'STUB-CL-DOES-NOT-EXIST', receivedAmount: 25_000 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.totalRows).toBe(4);
    expect(res.body.appliedCount).toBe(2);
    expect(res.body.unmatchedCount).toBe(2);
    expect(res.body.failedCount).toBe(0);

    const byRef = new Map<string, { outcome: string; reconciliationStatus?: string }>();
    for (const r of res.body.results as Array<{
      claimRefNum: string;
      outcome: string;
      reconciliationStatus?: string;
    }>) {
      byRef.set(r.claimRefNum, r);
    }
    expect(byRef.get(c1.claimRefNum)?.outcome).toBe('applied');
    expect(byRef.get(c1.claimRefNum)?.reconciliationStatus).toBe('manual_match_pending');
    expect(byRef.get(c2.claimRefNum)?.outcome).toBe('applied');
    expect(byRef.get(c2.claimRefNum)?.reconciliationStatus).toBe('short_paid');
    expect(byRef.get(c3.claimRefNum)?.outcome).toBe('unmatched_no_settlement');
    expect(byRef.get('STUB-CL-DOES-NOT-EXIST')?.outcome).toBe('unmatched_no_claim');

    // Claim status moved as expected.
    expect((await readClaim(migrator, c1.claimId))?.status).toBe('PAYMENT_RECEIVED');
    expect((await readClaim(migrator, c1.claimId))?.paidAmount).toBe(100_000);
    expect((await readClaim(migrator, c2.claimId))?.status).toBe('SHORT_PAID');
    expect((await readClaim(migrator, c2.claimId))?.paidAmount).toBe(150_000);
    // c3 stayed at CLAIM_APPROVED (no settlement opened, no transitions).
    expect((await readClaim(migrator, c3.claimId))?.status).toBe('CLAIM_APPROVED');

    // Slice AN — bankTxnId persists on the matched settlement when the
    // remittance row carries one, and stays null when it doesn't.
    const s1 = await readSettlement(migrator, c1.claimId);
    expect(s1?.bankTxnId).toBeNull();
    const s2 = await readSettlement(migrator, c2.claimId);
    expect(s2?.bankTxnId).toBe('BANK-9001');
    expect(s2?.reconciliationStatus).toBe('short_paid');
  });

  it('reader without settlement.upload_eob → 403', async () => {
    const adminCookies = await loginAs(ADMIN);
    const c1 = await caseAtPaymentPending(adminCookies, 'MRN-RB-PERM', 80_000);
    const readerCookies = await loginAs(READER);
    const res = await request(app.getHttpServer())
      .post('/settlement/remittance')
      .set('Cookie', readerCookies)
      .send({
        rows: [{ claimRefNum: c1.claimRefNum, receivedAmount: 80_000 }],
      });
    expect(res.status).toBe(403);
  });

  it('empty batch → 422 (Zod validation rejects rows.min(1))', async () => {
    const cookies = await loginAs(ADMIN);
    const res = await request(app.getHttpServer())
      .post('/settlement/remittance')
      .set('Cookie', cookies)
      .send({ rows: [] });
    expect(res.status).toBe(422);
  });
});
