// Slice BK — PMJAY runs eligibility three times with different
// purposes (validation / benefits / auth-requirements). The handler
// must enforce a `purpose` field on PMJAY tenants and dispatch each
// purpose as a single-element CoverageEligibilityRequest.purpose
// array. Private (non-PMJAY) tenants keep their legacy behaviour
// where omitting purpose yields the combined ['benefits','validation'].
//
//   1. PMJAY tenant + missing purpose → 422 with field-targeted error
//      from the service gate (NOT from Zod, because the schema marks
//      purpose optional for back-compat).
//   2. PMJAY tenant + purpose=validation on a fresh case → 200 +
//      status=ELIGIBILITY_VERIFIED + ledger rawResponse echoes purpose.
//   3. PMJAY tenant + purpose=benefits on a fresh case → 200 + echoes.
//   4. PMJAY tenant + purpose=auth-requirements → 200 + echoes.
//   5. Non-PMJAY tenant + omitted purpose → 200 (legacy combined-array
//      path); rawResponse does NOT echo a purpose field.

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

describe('Slice BK — PMJAY eligibility three-purpose dispatch', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const PMJAY_ADMIN = 'admin-pmjay@bk-test.local';
  const PLAIN_ADMIN = 'admin-plain@bk-test.local';

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
    process.env['NHCX_STUB_VERIFY_DEFAULT'] = 'true';

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const perms = ['case.create', 'case.view', 'audit.view'];
      const pmjayTenant = await tx.tenant.create({
        data: {
          slug: 'tenant-bk-pmjay',
          displayName: 'BK PMJAY',
          lifecycleState: 'IN_SETUP',
          pmjayMode: 'on',
        },
      });
      const pmjayRole = await tx.role.create({
        data: { tenantId: pmjayTenant.id, name: 'tenant_admin', permissions: perms },
      });
      const pmjayUser = await tx.user.create({
        data: {
          tenantId: pmjayTenant.id,
          email: PMJAY_ADMIN,
          passwordHash,
          firstName: 'PMJAY',
          lastName: 'Admin',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: pmjayTenant.id, userId: pmjayUser.id, roleId: pmjayRole.id },
      });

      const plainTenant = await tx.tenant.create({
        data: {
          slug: 'tenant-bk-plain',
          displayName: 'BK Plain',
          lifecycleState: 'IN_SETUP',
        },
      });
      const plainRole = await tx.role.create({
        data: { tenantId: plainTenant.id, name: 'tenant_admin', permissions: perms },
      });
      const plainUser = await tx.user.create({
        data: {
          tenantId: plainTenant.id,
          email: PLAIN_ADMIN,
          passwordHash,
          firstName: 'Plain',
          lastName: 'Admin',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: plainTenant.id, userId: plainUser.id, roleId: plainRole.id },
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
    await pg.shutdown();
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

  async function createCase(
    cookies: string[],
    mrn: string,
  ): Promise<{ caseId: string; claimId: string }> {
    const res = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'BK Patient',
        hospitalMrn: mrn,
        admissionDate: '2026-05-08',
        admissionType: 'planned',
        primaryRail: 'nhcx',
      });
    expect(res.status).toBe(201);
    return { caseId: res.body.id as string, claimId: res.body.claims[0].id as string };
  }

  async function getLedgerInbound(
    cookies: string[],
    caseId: string,
    claimId: string,
  ): Promise<Record<string, unknown>> {
    const ledger = await request(app.getHttpServer())
      .get(`/cases/${caseId}/claims/${claimId}/integration-messages`)
      .set('Cookie', cookies);
    expect(ledger.status).toBe(200);
    const messages = ledger.body.messages as Array<{
      direction: string;
      rawResponse: Record<string, unknown> | null;
    }>;
    const inbound = messages.find((m) => m.direction === 'inbound');
    expect(inbound).toBeDefined();
    return inbound!.rawResponse ?? {};
  }

  it('PMJAY tenant + missing purpose → 422 from service gate', async () => {
    const cookies = await loginAs(PMJAY_ADMIN);
    const { caseId, claimId } = await createCase(cookies, 'MRN-BK-PMJAY-MISSING');
    const r = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/eligibility`)
      .set('Cookie', cookies)
      .send({});
    expect(r.status).toBe(422);
    expect(r.body.errors?.purpose?.[0]).toMatch(/PMJAY eligibility requires a purpose/);
  });

  it('PMJAY tenant + purpose=validation → 200, ledger echoes purpose', async () => {
    const cookies = await loginAs(PMJAY_ADMIN);
    const { caseId, claimId } = await createCase(cookies, 'MRN-BK-PMJAY-VAL');
    const r = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/eligibility`)
      .set('Cookie', cookies)
      .send({ purpose: 'validation' });
    expect(r.status).toBe(200);
    expect(r.body.verified).toBe(true);
    expect(r.body.status).toBe('ELIGIBILITY_VERIFIED');

    const raw = await getLedgerInbound(cookies, caseId, claimId);
    expect(raw['purpose']).toBe('validation');
  });

  it('PMJAY tenant + purpose=benefits → 200, ledger echoes purpose', async () => {
    const cookies = await loginAs(PMJAY_ADMIN);
    const { caseId, claimId } = await createCase(cookies, 'MRN-BK-PMJAY-BEN');
    const r = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/eligibility`)
      .set('Cookie', cookies)
      .send({ purpose: 'benefits' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ELIGIBILITY_VERIFIED');

    const raw = await getLedgerInbound(cookies, caseId, claimId);
    expect(raw['purpose']).toBe('benefits');
  });

  it('PMJAY tenant + purpose=auth-requirements → 200, ledger echoes purpose', async () => {
    const cookies = await loginAs(PMJAY_ADMIN);
    const { caseId, claimId } = await createCase(cookies, 'MRN-BK-PMJAY-AUTH');
    const r = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/eligibility`)
      .set('Cookie', cookies)
      .send({ purpose: 'auth-requirements' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ELIGIBILITY_VERIFIED');

    const raw = await getLedgerInbound(cookies, caseId, claimId);
    expect(raw['purpose']).toBe('auth-requirements');
  });

  it('PMJAY tenant + bogus purpose value → 422 from Zod', async () => {
    const cookies = await loginAs(PMJAY_ADMIN);
    const { caseId, claimId } = await createCase(cookies, 'MRN-BK-PMJAY-BOGUS');
    const r = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/eligibility`)
      .set('Cookie', cookies)
      .send({ purpose: 'discovery' }); // valid FHIR R4 value, NOT in our enum
    expect(r.status).toBe(422);
  });

  it('non-PMJAY tenant + omitted purpose → 200 (legacy combined-array path)', async () => {
    const cookies = await loginAs(PLAIN_ADMIN);
    const { caseId, claimId } = await createCase(cookies, 'MRN-BK-PLAIN-LEGACY');
    const r = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/eligibility`)
      .set('Cookie', cookies)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ELIGIBILITY_VERIFIED');

    const raw = await getLedgerInbound(cookies, caseId, claimId);
    // Legacy callers don't carry a purpose; the stub only echoes it
    // when present, so absence here is the assertion.
    expect(raw['purpose']).toBeUndefined();
  });
});
