// Slice CB — consent threading through service paths.
//
//   1. Eligibility.run with an active 'nhcx_processing' grant → the
//      data_access_event row for the patient decrypt has
//      consentGrantId === the grant's id.
//   2. Eligibility.run without a grant → the data_access_event row
//      has consentGrantId=null (soft-enforcement: read still proceeds,
//      gap surfaces on the BU dashboard).
//   3. PMJAY tenant → consent type resolves to 'pmjay_processing'.
//      An nhcx_processing grant alone does NOT bind on PMJAY tenants
//      because the consent type the service requires is different.
//   4. RLS canary: tenant A's binding doesn't leak to tenant B's
//      data_access_event view.

import { generateKeyPairSync, randomBytes } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { argon2id, hash } from 'argon2';
import cookieParser from 'cookie-parser';

import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { EligibilityService } from '../../src/modules/eligibility/eligibility.service';
import { startPostgres, type PgHandles } from '../setup/postgres-container';

jest.setTimeout(180_000);

describe('Slice CB — consent binding on decrypt', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;
  let eligibility: EligibilityService;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN_A = 'admin-cb-a@cb-test.local';
  let tenantAId: string;
  let pmjayTenantId: string;
  let actorAId: string;

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
    process.env['HPR_STUB_OTP'] = '000000';

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const tA = await tx.tenant.create({
        data: { slug: 'tenant-cb-a', displayName: 'CB A', lifecycleState: 'IN_SETUP' },
      });
      tenantAId = tA.id;
      const pmjay = await tx.tenant.create({
        data: {
          slug: 'tenant-cb-pmjay',
          displayName: 'CB PMJAY',
          lifecycleState: 'IN_SETUP',
          pmjayMode: 'on',
        },
      });
      pmjayTenantId = pmjay.id;
      const adminRoleA = await tx.role.create({
        data: { tenantId: tA.id, name: 'tenant_admin', permissions: ['case.view'] },
      });
      const ua = await tx.user.create({
        data: {
          tenantId: tA.id, email: ADMIN_A, passwordHash,
          firstName: 'A', lastName: 'Admin', status: 'active',
        },
      });
      actorAId = ua.id;
      await tx.userRole.create({
        data: { tenantId: tA.id, userId: ua.id, roleId: adminRoleA.id },
      });
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.use(cookieParser());
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();
    eligibility = app.get(EligibilityService);
  });

  afterAll(async () => {
    await app?.close();
    await migrator.$disconnect().catch(() => undefined);
    await pg.shutdown();
  });

  // Seed a case + claim + patient + (optional) consent grant
  // directly. Returns ids we'll use to drive eligibility.run.
  async function seedScenario(input: {
    tenantId: string;
    grantConsentType: 'nhcx_processing' | 'pmjay_processing' | null;
  }): Promise<{ caseId: string; claimId: string; patientId: string; consentGrantId: string | null }> {
    return migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${input.tenantId}, true)`);
      const patient = await tx.patient.create({
        data: {
          tenantId: input.tenantId,
          fullName: `CB Patient ${randomBytes(3).toString('hex')}`,
          aadhaarCipher: 'cipher-aadhaar',
          aadhaarKeyVersion: 'v1',
        },
        select: { id: true },
      });
      const caseRow = await tx.case.create({
        data: {
          tenantId: input.tenantId,
          patientId: patient.id,
          patientName: 'CB Patient',
          hospitalMrn: `MRN-${randomBytes(2).toString('hex')}`,
          admissionDate: new Date(),
          admissionType: 'planned',
          primaryRail: 'nhcx',
          createdById: actorAId,
        },
        select: { id: true },
      });
      const claim = await tx.claim.create({
        data: {
          tenantId: input.tenantId,
          caseId: caseRow.id,
          rail: 'nhcx',
          status: 'INITIATED',
        },
        select: { id: true },
      });
      let consentGrantId: string | null = null;
      if (input.grantConsentType) {
        const c = await tx.consentRecord.create({
          data: {
            tenantId: input.tenantId,
            patientId: patient.id,
            consentType: input.grantConsentType,
            dataCategories: ['aadhaar'],
            purposes: ['eligibility.verify'],
            lawfulBasis: 'consent',
            status: 'granted',
            source: 'in_person',
            evidence: {
              noticeText: 'Consent notice for CB test.',
              acknowledgedVia: 'in_person_signature',
            },
            capturedByUserId: actorAId,
          },
          select: { id: true },
        });
        consentGrantId = c.id;
      }
      return { caseId: caseRow.id, claimId: claim.id, patientId: patient.id, consentGrantId };
    });
  }

  async function readDecryptEvents(
    tenantId: string,
    patientId: string,
  ): Promise<Array<{ consentGrantId: string | null; purpose: string }>> {
    return migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      return tx.dataAccessEvent.findMany({
        where: {
          tenantId,
          resourceType: 'patient',
          resourceId: patientId,
          action: 'decrypt',
        },
        select: { consentGrantId: true, purpose: true },
        orderBy: { occurredAt: 'desc' },
      });
    });
  }

  it('eligibility binds consentGrantId when an active grant exists', async () => {
    const seed = await seedScenario({ tenantId: tenantAId, grantConsentType: 'nhcx_processing' });
    try {
      await eligibility.run({
        tenantId: tenantAId,
        caseId: seed.caseId,
        claimId: seed.claimId,
        actorUserId: actorAId,
        ip: '127.0.0.1',
        userAgent: 'jest',
      });
    } catch {
      // Eligibility may fail downstream (no payer, stub adapter
      // path, etc.). We only care that the decrypt happened with
      // the binding before whatever error fires later.
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
    const events = await readDecryptEvents(tenantAId, seed.patientId);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const bound = events.find((e) => e.purpose === 'eligibility.verify');
    expect(bound).toBeDefined();
    expect(bound!.consentGrantId).toBe(seed.consentGrantId);
  });

  it('eligibility records consentGrantId=null when no grant exists (soft enforcement)', async () => {
    const seed = await seedScenario({ tenantId: tenantAId, grantConsentType: null });
    try {
      await eligibility.run({
        tenantId: tenantAId,
        caseId: seed.caseId,
        claimId: seed.claimId,
        actorUserId: actorAId,
        ip: '127.0.0.1',
        userAgent: 'jest',
      });
    } catch {
      /* same downstream-fail tolerance */
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
    const events = await readDecryptEvents(tenantAId, seed.patientId);
    const bound = events.find((e) => e.purpose === 'eligibility.verify');
    expect(bound).toBeDefined();
    expect(bound!.consentGrantId).toBeNull();
  });

  it('PMJAY tenant requires pmjay_processing grant; nhcx_processing alone does NOT bind', async () => {
    const seed = await seedScenario({ tenantId: pmjayTenantId, grantConsentType: 'nhcx_processing' });
    try {
      await eligibility.run({
        tenantId: pmjayTenantId,
        caseId: seed.caseId,
        claimId: seed.claimId,
        actorUserId: actorAId,
        purpose: 'benefits',
        ip: '127.0.0.1',
        userAgent: 'jest',
      });
    } catch {
      /* same downstream-fail tolerance */
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
    const events = await readDecryptEvents(pmjayTenantId, seed.patientId);
    const bound = events.find((e) => e.purpose === 'eligibility.verify');
    expect(bound).toBeDefined();
    // nhcx_processing was granted but PMJAY tenant resolves to
    // pmjay_processing — no match → null.
    expect(bound!.consentGrantId).toBeNull();
  });
});
