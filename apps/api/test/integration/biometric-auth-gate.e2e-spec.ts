// Slice BG — PMJAY biometric gate end to end.
//
//   1. Non-PMJAY tenant: preauth submit succeeds without biometric
//      (regression — the gate must not affect non-PMJAY tenants).
//   2. PMJAY tenant: preauth submit fails 412 BIOMETRIC_VERIFICATION_REQUIRED
//      when no recent biometric verification exists on the case.
//   3. PMJAY tenant: init returns a txnId, verify writes a
//      biometric_verification row, then submit succeeds.
//   4. Verify endpoint rejects mismatched authMode/PID combinations
//      with 422.
//   5. Verify endpoint surfaces adapter failure as 422
//      BIOMETRIC_VERIFICATION_FAILED (loginId on stub fail-list).

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

describe('Slice BG — PMJAY biometric gate', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const PMJAY_ADMIN = 'admin-pmjay@bg-test.local';
  const PLAIN_ADMIN = 'admin-plain@bg-test.local';
  const FAIL_LOGIN_ID = '91-FAIL-FAIL-0001';

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
    // Slice BG — biometric adapter must be in stub mode for the
    // PMJAY tenant in this test; the gate would otherwise stay stuck
    // (off-mode adapter returns 'disabled' on verify and never writes
    // a row, which is the intended platform-misconfig behaviour).
    process.env['BIOMETRIC_AUTH_MODE'] = 'stub';
    process.env['BIOMETRIC_AUTH_STUB_FAIL_LIST'] = FAIL_LOGIN_ID;

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      // PMJAY-mode tenant
      const pmjayTenant = await tx.tenant.create({
        data: {
          slug: 'tenant-bg-pmjay',
          displayName: 'BG PMJAY Hospital',
          lifecycleState: 'IN_SETUP',
          pmjayMode: 'on',
        },
      });
      const pmjayRole = await tx.role.create({
        data: {
          tenantId: pmjayTenant.id,
          name: 'tenant_admin',
          permissions: [
            'case.create',
            'case.view',
            'case.assign',
            'preauth.draft',
            'preauth.submit',
            'preauth.respond_query',
            'audit.view',
          ],
        },
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

      // Plain (non-PMJAY) tenant — gate must not fire for these.
      const plainTenant = await tx.tenant.create({
        data: {
          slug: 'tenant-bg-plain',
          displayName: 'BG Plain Hospital',
          lifecycleState: 'IN_SETUP',
        },
      });
      const plainRole = await tx.role.create({
        data: {
          tenantId: plainTenant.id,
          name: 'tenant_admin',
          permissions: [
            'case.create',
            'case.view',
            'case.assign',
            'preauth.draft',
            'preauth.submit',
            'preauth.respond_query',
            'audit.view',
          ],
        },
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

  // Walk a fresh case to PREAUTH_DRAFTING with a populated draft.
  async function caseReadyForSubmit(
    cookies: string[],
    mrn: string,
  ): Promise<{ caseId: string; claimId: string }> {
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
    expect(create.status).toBe(201);
    const caseId = create.body.id as string;
    const claimId = create.body.claims[0].id as string;

    // Slice BK: PMJAY tenants must specify a purpose for eligibility.
    // We're driving downstream preauth/biometric flow here, so pick
    // 'benefits' (the pre-preauth purpose) to satisfy the gate.
    const elig = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/eligibility`)
      .set('Cookie', cookies)
      .send({ purpose: 'benefits' });
    expect(elig.status).toBe(200);

    const tr = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/transitions`)
      .set('Cookie', cookies)
      .send({ eventType: 'preauth.drafting_started' });
    expect(tr.status).toBe(200);

    const draft = await request(app.getHttpServer())
      .put(`/cases/${caseId}/claims/${claimId}/preauth/draft`)
      .set('Cookie', cookies)
      .send({
        diagnosisIcdCode: 'I21',
        diagnosisDescription: 'Acute MI',
        plannedProcedure: 'CABG',
        procedureCode: '00.66',
        estimatedLengthOfStayDays: 5,
        requestedAmount: 250_000,
        clinicalJustification: 'Bypass surgery indicated.',
      });
    expect(draft.status).toBe(200);

    return { caseId, claimId };
  }

  it('non-PMJAY tenant: preauth submit succeeds without biometric (regression)', async () => {
    const cookies = await loginAs(PLAIN_ADMIN);
    const { caseId, claimId } = await caseReadyForSubmit(cookies, 'MRN-BG-PLAIN-1');

    const submit = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/submit`)
      .set('Cookie', cookies)
      .send({});
    expect(submit.status).toBe(200);
    expect(submit.body.status).toBe('PREAUTH_SUBMITTED');
  });

  it('PMJAY tenant: preauth submit without biometric → 412 BIOMETRIC_VERIFICATION_REQUIRED', async () => {
    const cookies = await loginAs(PMJAY_ADMIN);
    const { caseId, claimId } = await caseReadyForSubmit(cookies, 'MRN-BG-PMJAY-1');

    const submit = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/submit`)
      .set('Cookie', cookies)
      .send({});
    expect(submit.status).toBe(412);
    expect(submit.body.code).toBe('BIOMETRIC_VERIFICATION_REQUIRED');
  });

  it('PMJAY tenant: init → verify → preauth submit succeeds', async () => {
    const cookies = await loginAs(PMJAY_ADMIN);
    const { caseId, claimId } = await caseReadyForSubmit(cookies, 'MRN-BG-PMJAY-2');

    const init = await request(app.getHttpServer())
      .post(`/cases/${caseId}/biometric-auth/init`)
      .set('Cookie', cookies)
      .send({
        scope: 'aadhaar-bio-verify',
        loginHint: 'abha-number',
        loginId: '91-1234-5678-0002',
        authMode: 'FINGERPRINT',
        process: 'Preauth',
        payerId: 'pmjay@hcx',
        bearerToken: 'platform-jwt-stub',
      });
    expect(init.status).toBe(200);
    expect(init.body.status).toBe('init_ok');
    expect(typeof init.body.txnId).toBe('string');

    const verify = await request(app.getHttpServer())
      .post(`/cases/${caseId}/biometric-auth/verify`)
      .set('Cookie', cookies)
      .send({
        scope: 'aadhaar-bio-verify',
        authMode: 'FINGERPRINT',
        loginHint: 'abha-number',
        loginId: '91-1234-5678-0002',
        authData: {
          txnId: init.body.txnId,
          fingerPrintAuthPid: 'PID-BLOB-AAA',
        },
        process: 'Preauth',
        payerId: 'pmjay@hcx',
        bearerToken: 'platform-jwt-stub',
      });
    expect(verify.status).toBe(200);
    expect(verify.body.status).toBe('verified');
    expect(typeof verify.body.verificationId).toBe('string');
    expect(typeof verify.body.expiresAt).toBe('string');

    const submit = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/submit`)
      .set('Cookie', cookies)
      .send({});
    expect(submit.status).toBe(200);
    expect(submit.body.status).toBe('PREAUTH_SUBMITTED');
  });

  it('verify rejects authMode/PID mismatch with 422', async () => {
    const cookies = await loginAs(PMJAY_ADMIN);
    const create = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'Patient',
        hospitalMrn: 'MRN-BG-PMJAY-3',
        admissionDate: '2026-05-01',
        admissionType: 'planned',
        primaryRail: 'nhcx',
      });
    expect(create.status).toBe(201);
    const caseId = create.body.id as string;

    const init = await request(app.getHttpServer())
      .post(`/cases/${caseId}/biometric-auth/init`)
      .set('Cookie', cookies)
      .send({
        scope: 'aadhaar-bio-verify',
        loginHint: 'abha-number',
        loginId: '91-1234-5678-0003',
        authMode: 'FINGERPRINT',
        process: 'Preauth',
        payerId: 'pmjay@hcx',
        bearerToken: 'platform-jwt-stub',
      });
    expect(init.status).toBe(200);

    // FINGERPRINT mode but operator sent the face PID — server must
    // reject before the adapter call.
    const verify = await request(app.getHttpServer())
      .post(`/cases/${caseId}/biometric-auth/verify`)
      .set('Cookie', cookies)
      .send({
        scope: 'aadhaar-bio-verify',
        authMode: 'FINGERPRINT',
        loginHint: 'abha-number',
        loginId: '91-1234-5678-0003',
        authData: {
          txnId: init.body.txnId,
          faceAuthPid: 'WRONG-PID',
        },
        process: 'Preauth',
        payerId: 'pmjay@hcx',
        bearerToken: 'platform-jwt-stub',
      });
    expect(verify.status).toBe(422);
  });

  it('init surfaces adapter failure (loginId on stub fail-list) as 422', async () => {
    const cookies = await loginAs(PMJAY_ADMIN);
    const create = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'Patient',
        hospitalMrn: 'MRN-BG-PMJAY-4',
        admissionDate: '2026-05-01',
        admissionType: 'planned',
        primaryRail: 'nhcx',
      });
    expect(create.status).toBe(201);
    const caseId = create.body.id as string;

    const init = await request(app.getHttpServer())
      .post(`/cases/${caseId}/biometric-auth/init`)
      .set('Cookie', cookies)
      .send({
        scope: 'aadhaar-bio-verify',
        loginHint: 'abha-number',
        loginId: FAIL_LOGIN_ID,
        authMode: 'FINGERPRINT',
        process: 'Preauth',
        payerId: 'pmjay@hcx',
        bearerToken: 'platform-jwt-stub',
      });
    expect(init.status).toBe(422);
    expect(init.body.code).toBe('BIOMETRIC_VERIFICATION_FAILED');
  });
});
