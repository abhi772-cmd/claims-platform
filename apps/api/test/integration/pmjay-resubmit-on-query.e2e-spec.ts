// Slice BL — PMJAY tenants don't respond to queries via Communication;
// they pull the preauth (or claim) back to the drafting state and
// re-submit. The Communication-based response endpoint rejects PMJAY
// callers; the new resubmit endpoint accepts only PMJAY callers.
//
//   1. PMJAY tenant: POST /preauth/queries/:queryId/respond → 422 with
//      tenant-field error pointing operator at /preauth/resubmit.
//   2. PMJAY tenant: POST /preauth/resubmit from PREAUTH_QUERY_RAISED
//      → 200 + claim back at PREAUTH_DRAFTING + outstanding query
//      stamped responseText='[resubmit] ...'.
//   3. Non-PMJAY tenant: POST /preauth/resubmit → 422 with tenant-field
//      error (PMJAY-only operation).
//   4. PMJAY tenant: POST /claim-submission/resubmit from CLAIM_QUERY_RAISED
//      → 200 + claim back at CLAIM_DRAFTING.
//   5. Non-PMJAY tenant: POST /claim-submission/resubmit → 422.
//   6. PMJAY tenant: resubmit from non-QUERY_RAISED (PREAUTH_DRAFTING)
//      → 422 from the state machine.
//
// The fast-forward path uses POST /transitions (admin escape hatch,
// CASE_ASSIGN-gated) instead of walking through the real preauth +
// biometric flow — this slice's contract is the resubmit transition,
// not the full PMJAY happy path.

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

describe('Slice BL — PMJAY resubmit on query (drop Communication-based response)', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const PMJAY_ADMIN = 'admin-pmjay@bl-test.local';
  const PLAIN_ADMIN = 'admin-plain@bl-test.local';
  let pmjayTenantId: string;

  const PERMS = [
    'case.create',
    'case.view',
    'case.assign',
    'preauth.draft',
    'preauth.submit',
    'preauth.respond_query',
    'claim.draft',
    'claim.submit',
    'claim.respond_query',
    'audit.view',
  ];

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
      const pmjayTenant = await tx.tenant.create({
        data: {
          slug: 'tenant-bl-pmjay',
          displayName: 'BL PMJAY',
          lifecycleState: 'IN_SETUP',
          pmjayMode: 'on',
        },
      });
      pmjayTenantId = pmjayTenant.id;
      const pmjayRole = await tx.role.create({
        data: { tenantId: pmjayTenant.id, name: 'tenant_admin', permissions: PERMS },
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
          slug: 'tenant-bl-plain',
          displayName: 'BL Plain',
          lifecycleState: 'IN_SETUP',
        },
      });
      const plainRole = await tx.role.create({
        data: { tenantId: plainTenant.id, name: 'tenant_admin', permissions: PERMS },
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

  async function transition(
    cookies: string[],
    caseId: string,
    claimId: string,
    eventType: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const r = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/transitions`)
      .set('Cookie', cookies)
      .send({ eventType, ...(payload ? { payload } : {}) });
    expect(r.status).toBe(200);
  }

  async function createCase(
    cookies: string[],
    mrn: string,
  ): Promise<{ caseId: string; claimId: string }> {
    const create = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'BL Patient',
        hospitalMrn: mrn,
        admissionDate: '2026-05-08',
        admissionType: 'planned',
        primaryRail: 'nhcx',
      });
    expect(create.status).toBe(201);
    return { caseId: create.body.id as string, claimId: create.body.claims[0].id as string };
  }

  // Walk via /transitions to PREAUTH_QUERY_RAISED. Bypasses the real
  // preauth/submit + biometric path because this slice tests the
  // resubmit transition, not the full PMJAY happy path.
  async function caseAtPreauthQueryRaised(
    cookies: string[],
    mrn: string,
  ): Promise<{ caseId: string; claimId: string }> {
    const { caseId, claimId } = await createCase(cookies, mrn);
    await transition(cookies, caseId, claimId, 'eligibility.requested');
    await transition(cookies, caseId, claimId, 'eligibility.verified');
    await transition(cookies, caseId, claimId, 'preauth.drafting_started');
    await transition(cookies, caseId, claimId, 'preauth.submitted_internally');
    await transition(cookies, caseId, claimId, 'preauth.acknowledged_by_payer');
    await transition(cookies, caseId, claimId, 'preauth.query_received', {
      queryText: 'Need additional clinical notes.',
    });
    return { caseId, claimId };
  }

  async function caseAtClaimQueryRaised(
    cookies: string[],
    mrn: string,
  ): Promise<{ caseId: string; claimId: string }> {
    const { caseId, claimId } = await createCase(cookies, mrn);
    await transition(cookies, caseId, claimId, 'eligibility.requested');
    await transition(cookies, caseId, claimId, 'eligibility.verified');
    await transition(cookies, caseId, claimId, 'preauth.drafting_started');
    await transition(cookies, caseId, claimId, 'preauth.submitted_internally');
    await transition(cookies, caseId, claimId, 'preauth.acknowledged_by_payer');
    await transition(cookies, caseId, claimId, 'preauth.approved');
    await transition(cookies, caseId, claimId, 'discharge.initiated');
    await transition(cookies, caseId, claimId, 'discharge.submitted');
    await transition(cookies, caseId, claimId, 'claim.drafting_started');
    await transition(cookies, caseId, claimId, 'claim.submitted_internally');
    await transition(cookies, caseId, claimId, 'claim.acknowledged');
    await transition(cookies, caseId, claimId, 'claim.query_received', {
      queryText: 'Receipt missing — please re-submit.',
    });
    return { caseId, claimId };
  }

  it('PMJAY tenant: POST /preauth/queries/:queryId/respond → 422 pointing at /preauth/resubmit', async () => {
    const cookies = await loginAs(PMJAY_ADMIN);
    const { caseId, claimId } = await caseAtPreauthQueryRaised(cookies, 'MRN-BL-PMJAY-RESP');
    // Insert a synthetic preauth_query row so the path resolves to a
    // real id; the gate fires before the row is read.
    const queryId = (
      await migrator.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT gen_random_uuid()::text AS id`,
      )
    )[0]!.id;

    const r = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/queries/${queryId}/respond`)
      .set('Cookie', cookies)
      .send({ responseText: 'Attached the requested notes.' });
    expect(r.status).toBe(422);
    expect(r.body.errors?.tenant?.[0]).toMatch(/PMJAY tenants do not respond to queries/i);
    expect(r.body.errors?.tenant?.[0]).toMatch(/\/preauth\/resubmit/);
  });

  it('PMJAY tenant: POST /preauth/resubmit → 200 + claim PREAUTH_DRAFTING', async () => {
    const cookies = await loginAs(PMJAY_ADMIN);
    const { caseId, claimId } = await caseAtPreauthQueryRaised(cookies, 'MRN-BL-PMJAY-OK');

    // Seed a real preauth_query row so we can assert the responseText
    // stamp. RLS-bypass via migrator + platform_admin context.
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.tenant_id', ${pmjayTenantId}, true)`,
      );
      await tx.preauthQuery.create({
        data: {
          tenantId: pmjayTenantId,
          claimId,
          queryText: 'Need additional clinical notes.',
        },
      });
    });

    const r = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/resubmit`)
      .set('Cookie', cookies)
      .send({ reason: 'Adding cardiology notes per query.' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('PREAUTH_DRAFTING');

    // Outstanding queries on the claim should now be marked
    // resolved-by-resubmit (responseText prefixed [resubmit]).
    const stamped = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.tenant_id', ${pmjayTenantId}, true)`,
      );
      return tx.preauthQuery.findMany({ where: { claimId } });
    });
    expect(stamped.length).toBe(1);
    expect(stamped[0]!.respondedAt).not.toBeNull();
    expect(stamped[0]!.responseText).toMatch(/^\[resubmit\] /);
  });

  it('non-PMJAY tenant: POST /preauth/resubmit → 422 (PMJAY-only)', async () => {
    const cookies = await loginAs(PLAIN_ADMIN);
    const { caseId, claimId } = await caseAtPreauthQueryRaised(cookies, 'MRN-BL-PLAIN');
    const r = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/resubmit`)
      .set('Cookie', cookies)
      .send({});
    expect(r.status).toBe(422);
    expect(r.body.errors?.tenant?.[0]).toMatch(/PMJAY-only/);
  });

  it('PMJAY tenant: POST /claim-submission/resubmit → 200 + claim CLAIM_DRAFTING', async () => {
    const cookies = await loginAs(PMJAY_ADMIN);
    const { caseId, claimId } = await caseAtClaimQueryRaised(cookies, 'MRN-BL-CLAIM-OK');
    const r = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/claim-submission/resubmit`)
      .set('Cookie', cookies)
      .send({ reason: 'Re-uploading receipts.' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('CLAIM_DRAFTING');
  });

  it('non-PMJAY tenant: POST /claim-submission/resubmit → 422', async () => {
    const cookies = await loginAs(PLAIN_ADMIN);
    const { caseId, claimId } = await caseAtClaimQueryRaised(cookies, 'MRN-BL-CLAIM-PLAIN');
    const r = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/claim-submission/resubmit`)
      .set('Cookie', cookies)
      .send({});
    expect(r.status).toBe(422);
    expect(r.body.errors?.tenant?.[0]).toMatch(/PMJAY-only/);
  });

  it('PMJAY tenant: resubmit from non-QUERY_RAISED state → 422 (state machine)', async () => {
    const cookies = await loginAs(PMJAY_ADMIN);
    const { caseId, claimId } = await createCase(cookies, 'MRN-BL-PMJAY-WRONG');
    // Walk only to PREAUTH_DRAFTING, no query raised.
    await transition(cookies, caseId, claimId, 'eligibility.requested');
    await transition(cookies, caseId, claimId, 'eligibility.verified');
    await transition(cookies, caseId, claimId, 'preauth.drafting_started');

    const r = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/resubmit`)
      .set('Cookie', cookies)
      .send({});
    expect(r.status).toBe(422);
  });
});
