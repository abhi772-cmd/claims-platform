// Slice BI — PMJAY claim reprocess (CRC) via outbound NHCX
// `task/submit` with `code: 'reprocess'`.
//
//   1. PMJAY tenant on a CLAIM_REJECTED claim with reasonCode=
//      'claimrejected' → 200 + claim → CLAIM_REPROCESS_REQUESTED
//      + ledger pair.
//   2. Non-PMJAY tenant: rejected at the service tenant gate → 422.
//   3. PMJAY tenant: reasonCode/status mismatch (claimrejected on
//      a non-rejected claim) → 422 with reasonCode field error.
//   4. PMJAY tenant: reprocess before claim was acknowledged (no
//      claimRefNum) → 422 with claimRefNum field error.

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

describe('Slice BI — PMJAY claim reprocess (CRC)', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const PMJAY_ADMIN = 'admin-pmjay@bi-test.local';
  const PLAIN_ADMIN = 'admin-plain@bi-test.local';

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
      const seedRolePerms = [
        'case.create',
        'case.view',
        'case.assign',
        'preauth.draft',
        'preauth.submit',
        'preauth.cancel',
        'preauth.respond_query',
        'claim.draft',
        'claim.submit',
        'claim.reprocess',
        'audit.view',
      ];
      const pmjayTenant = await tx.tenant.create({
        data: {
          slug: 'tenant-bi-pmjay',
          displayName: 'BI PMJAY Hospital',
          lifecycleState: 'IN_SETUP',
          pmjayMode: 'on',
        },
      });
      const pmjayRole = await tx.role.create({
        data: {
          tenantId: pmjayTenant.id,
          name: 'tenant_admin',
          permissions: seedRolePerms,
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
          slug: 'tenant-bi-plain',
          displayName: 'BI Plain Hospital',
          lifecycleState: 'IN_SETUP',
        },
      });
      const plainRole = await tx.role.create({
        data: {
          tenantId: plainTenant.id,
          name: 'tenant_admin',
          permissions: seedRolePerms,
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

  // Bring a fresh case to CLAIM_REJECTED with a populated claimRefNum.
  // Walks: create → eligibility → preauth (with biometric for PMJAY)
  // → preauth approved → discharge initiated/submitted → claim drafting
  // → claim submit → claim rejected. Returns the case+claim ids.
  async function caseAtClaimRejected(
    cookies: string[],
    mrn: string,
    pmjay: boolean,
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

    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/eligibility`)
      .set('Cookie', cookies)
      .send({})
      .expect(200);

    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/transitions`)
      .set('Cookie', cookies)
      .send({ eventType: 'preauth.drafting_started' })
      .expect(200);

    await request(app.getHttpServer())
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
      })
      .expect(200);

    if (pmjay) {
      await captureBiometric(cookies, caseId, 'Preauth', `91-1234-5678-${mrn.slice(-4)}`);
    }

    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/submit`)
      .set('Cookie', cookies)
      .send({})
      .expect(200);

    // Mark preauth approved (admin escape hatch).
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/decision`)
      .set('Cookie', cookies)
      .send({ kind: 'approved', approvedAmount: 250_000 })
      .expect(200);

    // Discharge → claim drafting.
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/transitions`)
      .set('Cookie', cookies)
      .send({ eventType: 'discharge.initiated' })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/transitions`)
      .set('Cookie', cookies)
      .send({ eventType: 'discharge.submitted' })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/claim-submission/start`)
      .set('Cookie', cookies)
      .send({})
      .expect(200);

    if (pmjay) {
      await captureBiometric(cookies, caseId, 'Discharge', `91-1234-5678-${mrn.slice(-4)}`);
    }

    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/claim-submission/submit`)
      .set('Cookie', cookies)
      .send({ finalAmount: 250_000 })
      .expect(200);

    // Reject the claim (admin escape hatch).
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/claim-submission/decision`)
      .set('Cookie', cookies)
      .send({ kind: 'rejected', reason: 'Documentation insufficient.' })
      .expect(200);

    return { caseId, claimId };
  }

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
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/biometric-auth/verify`)
      .set('Cookie', cookies)
      .send({
        scope: 'aadhaar-bio-verify',
        authMode: 'FINGERPRINT',
        loginHint: 'abha-number',
        loginId,
        authData: { txnId: init.body.txnId, fingerPrintAuthPid: 'PID' },
        process,
        payerId: 'pmjay@hcx',
        bearerToken: 'platform-jwt-stub',
      })
      .expect(200);
  }

  it('PMJAY tenant: reprocess from CLAIM_REJECTED → CLAIM_REPROCESS_REQUESTED + ledger', async () => {
    const cookies = await loginAs(PMJAY_ADMIN);
    const { caseId, claimId } = await caseAtClaimRejected(cookies, 'MRN-BI-1001', true);

    const r = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/claim-submission/reprocess`)
      .set('Cookie', cookies)
      .send({
        reasonCode: 'claimrejected',
        reason: 'Additional discharge summary attached out-of-band.',
      });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('CLAIM_REPROCESS_REQUESTED');
    expect(typeof r.body.correlationId).toBe('string');

    const ledger = await request(app.getHttpServer())
      .get(`/cases/${caseId}/claims/${claimId}/integration-messages`)
      .set('Cookie', cookies);
    const reprocessRows = ledger.body.messages.filter(
      (m: { operation: string }) => m.operation === 'claim.reprocess',
    );
    expect(reprocessRows.length).toBe(2); // outbound + inbound pair
  });

  it('non-PMJAY tenant: reprocess rejected at tenant gate → 422', async () => {
    const cookies = await loginAs(PLAIN_ADMIN);
    const { caseId, claimId } = await caseAtClaimRejected(cookies, 'MRN-BI-2001', false);

    const r = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/claim-submission/reprocess`)
      .set('Cookie', cookies)
      .send({ reasonCode: 'claimrejected' });
    expect(r.status).toBe(422);
    expect(r.body.errors?.tenant?.[0]).toMatch(/PMJAY-only/);
  });

  it("PMJAY tenant: reasonCode='partialpayment' on a CLAIM_REJECTED claim → 422", async () => {
    const cookies = await loginAs(PMJAY_ADMIN);
    const { caseId, claimId } = await caseAtClaimRejected(cookies, 'MRN-BI-1002', true);

    const r = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/claim-submission/reprocess`)
      .set('Cookie', cookies)
      .send({ reasonCode: 'partialpayment' });
    expect(r.status).toBe(422);
    expect(r.body.errors?.reasonCode?.[0]).toMatch(/SHORT_PAID/);
  });
});
