// Slice BH — preauth cancel via outbound NHCX `task/submit`.
//
//   1. PMJAY tenant: walk to PREAUTH_SUBMITTED, cancel → 200 +
//      claim → PREAUTH_CANCELLED + outbound ledger row written +
//      correlationId echoed.
//   2. Non-PMJAY tenant: cancel rejected at the service tenant gate
//      → 422 with `tenant` field error (PMJAY-only operation).
//   3. PMJAY tenant: cancel before preauth was submitted (no
//      preauthRefNum on the claim) → 422 with `preauthRefNum`
//      field error.
//   4. PMJAY tenant: cancel from PREAUTH_DRAFTING (no submit yet)
//      → 422 (state machine refuses or preauthRefNum guard fires
//      first — either way operator sees a clean validation error).

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

describe('Slice BH — PMJAY preauth cancel', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const PMJAY_ADMIN = 'admin-pmjay@bh-test.local';
  const PLAIN_ADMIN = 'admin-plain@bh-test.local';

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
    process.env['BIOMETRIC_AUTH_MODE'] = 'stub';

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const pmjayTenant = await tx.tenant.create({
        data: {
          slug: 'tenant-bh-pmjay',
          displayName: 'BH PMJAY Hospital',
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
            'preauth.cancel',
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

      const plainTenant = await tx.tenant.create({
        data: {
          slug: 'tenant-bh-plain',
          displayName: 'BH Plain Hospital',
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
            'preauth.cancel',
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

  // Walk to PREAUTH_DRAFTING with a populated draft.
  async function caseAtDrafting(
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

    const elig = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/eligibility`)
      .set('Cookie', cookies)
      .send({});
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

  // PMJAY-mode submit needs a biometric verify on the case for the
  // BG gate to pass. Returns the txnId used so callers can chain.
  async function captureBiometric(
    cookies: string[],
    caseId: string,
    process: 'Preauth' | 'Discharge',
    loginId: string,
  ): Promise<void> {
    const init = await request(app.getHttpServer())
      .post(`/cases/${caseId}/biometric-auth/init`)
      .set('Cookie', cookies)
      .send({
        scope: 'aadhaar-bio-verify',
        loginHint: 'abha-number',
        loginId,
        authMode: 'FINGERPRINT',
        process,
        payerId: 'pmjay@hcx',
        bearerToken: 'platform-jwt-stub',
      });
    expect(init.status).toBe(200);
    const verify = await request(app.getHttpServer())
      .post(`/cases/${caseId}/biometric-auth/verify`)
      .set('Cookie', cookies)
      .send({
        scope: 'aadhaar-bio-verify',
        authMode: 'FINGERPRINT',
        loginHint: 'abha-number',
        loginId,
        authData: { txnId: init.body.txnId, fingerPrintAuthPid: 'PID-BLOB-AAA' },
        process,
        payerId: 'pmjay@hcx',
        bearerToken: 'platform-jwt-stub',
      });
    expect(verify.status).toBe(200);
  }

  async function submitPreauth(
    cookies: string[],
    caseId: string,
    claimId: string,
  ): Promise<{ status: string; payerRefNum: string }> {
    const r = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/submit`)
      .set('Cookie', cookies)
      .send({});
    expect(r.status).toBe(200);
    return { status: r.body.status, payerRefNum: r.body.payerRefNum };
  }

  it('PMJAY tenant: cancel from PREAUTH_SUBMITTED → 200 + claim PREAUTH_CANCELLED + ledger row', async () => {
    const cookies = await loginAs(PMJAY_ADMIN);
    const { caseId, claimId } = await caseAtDrafting(cookies, 'MRN-BH-PMJAY-1');
    await captureBiometric(cookies, caseId, 'Preauth', '91-1234-5678-0001');
    const submitOut = await submitPreauth(cookies, caseId, claimId);
    expect(submitOut.status).toBe('PREAUTH_SUBMITTED');

    const cancel = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/cancel`)
      .set('Cookie', cookies)
      .send({ reason: 'Patient discharged against medical advice.' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe('PREAUTH_CANCELLED');
    expect(typeof cancel.body.correlationId).toBe('string');

    const ledger = await request(app.getHttpServer())
      .get(`/cases/${caseId}/claims/${claimId}/integration-messages`)
      .set('Cookie', cookies);
    const cancelRows = ledger.body.messages.filter(
      (m: { operation: string }) => m.operation === 'preauth.cancel',
    );
    expect(cancelRows.length).toBe(2); // outbound + inbound ledger pair
  });

  it('non-PMJAY tenant: cancel rejected at tenant gate → 422', async () => {
    const cookies = await loginAs(PLAIN_ADMIN);
    const { caseId, claimId } = await caseAtDrafting(cookies, 'MRN-BH-PLAIN-1');
    // Drive to PREAUTH_SUBMITTED — non-PMJAY tenant, no biometric needed.
    const submitOut = await submitPreauth(cookies, caseId, claimId);
    expect(submitOut.status).toBe('PREAUTH_SUBMITTED');

    const cancel = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/cancel`)
      .set('Cookie', cookies)
      .send({ reason: 'Operator changed mind.' });
    expect(cancel.status).toBe(422);
    expect(cancel.body.errors?.tenant?.[0]).toMatch(/PMJAY-only/);
  });

  it('PMJAY tenant: cancel before submit (no preauthRefNum) → 422', async () => {
    const cookies = await loginAs(PMJAY_ADMIN);
    const { caseId, claimId } = await caseAtDrafting(cookies, 'MRN-BH-PMJAY-2');
    // Skip submit — claim sits at PREAUTH_DRAFTING with no preauthRefNum.

    const cancel = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/cancel`)
      .set('Cookie', cookies)
      .send({});
    expect(cancel.status).toBe(422);
    expect(cancel.body.errors?.preauthRefNum?.[0]).toMatch(/preauth reference/);
  });
});
