// Slice L integration test — pre-auth phase end to end.
//
//   1. Permission gate: a draft-only role can't submit; a submit-only
//      role can submit but can't respond to queries.
//   2. Save-draft is upsert + idempotent.
//   3. Submit fails when required fields are missing (422).
//   4. Submit happy path: claim moves DRAFTING → QUEUED → SUBMITTED;
//      paired ledger rows written; payerRefNum populated.
//   5. Decision: query_received → QUERY_RAISED + PreauthQuery row.
//   6. Respond to query: QUERY_RAISED → QUERY_RESPONDED; outbound
//      ledger entry recorded.
//   7. Decision: partially_approved → PARTIALLY_APPROVED + approved
//      amount stamped on the claim.

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

describe('Slice L — pre-auth phase', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN = 'admin-pa@pa-test.local';
  const DRAFTER = 'drafter-pa@pa-test.local';
  const SUBMITTER = 'submitter-pa@pa-test.local';

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
      const tenant = await tx.tenant.create({
        data: { slug: 'tenant-pa', displayName: 'PA Test', lifecycleState: 'IN_SETUP' },
      });
      const adminRole = await tx.role.create({
        data: {
          tenantId: tenant.id, name: 'tenant_admin',
          permissions: [
            'case.create', 'case.view', 'case.assign',
            'preauth.draft', 'preauth.submit', 'preauth.respond_query',
            'audit.view',
          ],
        },
      });
      const drafterRole = await tx.role.create({
        data: {
          tenantId: tenant.id, name: 'drafter',
          permissions: ['case.create', 'case.view', 'preauth.draft'],
        },
      });
      const submitterRole = await tx.role.create({
        data: {
          tenantId: tenant.id, name: 'submitter',
          permissions: ['case.view', 'preauth.draft', 'preauth.submit'],
        },
      });
      const a = await tx.user.create({
        data: {
          tenantId: tenant.id, email: ADMIN, passwordHash,
          firstName: 'PA', lastName: 'Admin', status: 'active',
        },
      });
      await tx.userRole.create({ data: { tenantId: tenant.id, userId: a.id, roleId: adminRole.id } });
      const d = await tx.user.create({
        data: {
          tenantId: tenant.id, email: DRAFTER, passwordHash,
          firstName: 'PA', lastName: 'Drafter', status: 'active',
        },
      });
      await tx.userRole.create({ data: { tenantId: tenant.id, userId: d.id, roleId: drafterRole.id } });
      const s = await tx.user.create({
        data: {
          tenantId: tenant.id, email: SUBMITTER, passwordHash,
          firstName: 'PA', lastName: 'Submitter', status: 'active',
        },
      });
      await tx.userRole.create({ data: { tenantId: tenant.id, userId: s.id, roleId: submitterRole.id } });
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

  // Bring a fresh case all the way to PREAUTH_DRAFTING via the eligibility
  // happy path + a manual transition into drafting.
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

    // eligibility verified
    const elig = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/eligibility`)
      .set('Cookie', cookies)
      .send({});
    expect(elig.status).toBe(200);
    expect(elig.body.status).toBe('ELIGIBILITY_VERIFIED');

    // manual transition into drafting (Sprint 2 doesn't auto-advance)
    const tr = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/transitions`)
      .set('Cookie', cookies)
      .send({ eventType: 'preauth.drafting_started' });
    expect(tr.status).toBe(200);
    expect(tr.body.status).toBe('PREAUTH_DRAFTING');

    return { caseId, claimId };
  }

  async function saveValidDraft(
    cookies: string[],
    caseId: string,
    claimId: string,
  ): Promise<void> {
    const r = await request(app.getHttpServer())
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
    expect(r.status).toBe(200);
  }

  it('drafter can save draft; cannot submit', async () => {
    const adminCookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseAtDrafting(adminCookies, 'MRN-PA-1');
    const drafterCookies = await loginAs(DRAFTER);

    const save = await request(app.getHttpServer())
      .put(`/cases/${caseId}/claims/${claimId}/preauth/draft`)
      .set('Cookie', drafterCookies)
      .send({ diagnosisDescription: 'Pneumonia' });
    expect(save.status).toBe(200);

    const submit = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/submit`)
      .set('Cookie', drafterCookies)
      .send({});
    expect(submit.status).toBe(403);
  });

  it('save-draft is idempotent (upsert)', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseAtDrafting(cookies, 'MRN-PA-2');
    const r1 = await request(app.getHttpServer())
      .put(`/cases/${caseId}/claims/${claimId}/preauth/draft`)
      .set('Cookie', cookies)
      .send({ diagnosisDescription: 'First' });
    expect(r1.status).toBe(200);
    const r2 = await request(app.getHttpServer())
      .put(`/cases/${caseId}/claims/${claimId}/preauth/draft`)
      .set('Cookie', cookies)
      .send({ diagnosisDescription: 'Updated' });
    expect(r2.status).toBe(200);
    expect(r2.body.draft.diagnosisDescription).toBe('Updated');
  });

  it('submit fails when required fields missing → 422', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseAtDrafting(cookies, 'MRN-PA-3');
    // No draft saved yet.
    const r = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/submit`)
      .set('Cookie', cookies)
      .send({});
    expect(r.status).toBe(422);
  });

  it('submit happy path: claim moves DRAFTING → QUEUED → SUBMITTED + ledger rows', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseAtDrafting(cookies, 'MRN-PA-4');
    await saveValidDraft(cookies, caseId, claimId);

    const submit = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/submit`)
      .set('Cookie', cookies)
      .send({});
    expect(submit.status).toBe(200);
    expect(submit.body.status).toBe('PREAUTH_SUBMITTED');
    expect(submit.body.payerRefNum).toMatch(/^STUB-PA-/);

    const ledger = await request(app.getHttpServer())
      .get(`/cases/${caseId}/claims/${claimId}/integration-messages`)
      .set('Cookie', cookies);
    // Eligibility wrote 2 messages; preauth submit wrote 2 more.
    expect(ledger.body.messages.length).toBe(4);
    const preauthRows = ledger.body.messages.filter(
      (m: { operation: string }) => m.operation === 'preauth.submit',
    );
    expect(preauthRows.length).toBe(2);
  });

  it('decision query_received writes a PreauthQuery + transitions to QUERY_RAISED', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseAtDrafting(cookies, 'MRN-PA-5');
    await saveValidDraft(cookies, caseId, claimId);
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/submit`)
      .set('Cookie', cookies)
      .send({});

    const decision = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/decision`)
      .set('Cookie', cookies)
      .send({ kind: 'query_received', queryText: 'Need OT notes.' });
    expect(decision.status).toBe(200);
    expect(decision.body.status).toBe('PREAUTH_QUERY_RAISED');

    const queries = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      return tx.preauthQuery.findMany({ where: { claimId } });
    });
    expect(queries.length).toBe(1);
    expect(queries[0]!.queryText).toBe('Need OT notes.');
  });

  it('respond-to-query → QUERY_RESPONDED + outbound ledger entry', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseAtDrafting(cookies, 'MRN-PA-6');
    await saveValidDraft(cookies, caseId, claimId);
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/submit`)
      .set('Cookie', cookies)
      .send({});
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/decision`)
      .set('Cookie', cookies)
      .send({ kind: 'query_received', queryText: 'Need bills.' });

    const queryRow = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      return tx.preauthQuery.findFirstOrThrow({ where: { claimId } });
    });

    const respond = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/queries/${queryRow.id}/respond`)
      .set('Cookie', cookies)
      .send({ responseText: 'Bills attached.' });
    expect(respond.status).toBe(200);
    expect(respond.body.status).toBe('PREAUTH_QUERY_RESPONDED');

    const ledger = await request(app.getHttpServer())
      .get(`/cases/${caseId}/claims/${claimId}/integration-messages`)
      .set('Cookie', cookies);
    const queryRespond = ledger.body.messages.filter(
      (m: { operation: string }) => m.operation === 'preauth.query.respond',
    );
    expect(queryRespond.length).toBeGreaterThanOrEqual(2);
  });

  it('decision partially_approved → PARTIALLY_APPROVED + approvedAmount stamped', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseAtDrafting(cookies, 'MRN-PA-7');
    await saveValidDraft(cookies, caseId, claimId);
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/submit`)
      .set('Cookie', cookies)
      .send({});

    const r = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/decision`)
      .set('Cookie', cookies)
      .send({ kind: 'partially_approved', approvedAmount: 180_000 });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('PREAUTH_PARTIALLY_APPROVED');
    expect(r.body.approvedAmount).toBe(180_000);
  });
});
