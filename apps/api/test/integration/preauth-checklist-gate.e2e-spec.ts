// T1.1 integration test — pre-auth document checklist enforcement gate.
//
//   1. Gate fires: a `required: true` preauth checklist rule with no
//      matching upload blocks submit with 412 PREAUTH_DOCUMENTS_INCOMPLETE
//      and lists the missing documentType(s).
//   2. Gate clears: once the required document is uploaded (upload-stub →
//      completed + clean/skipped), the same submit succeeds.
//   3. Vacuous pass: with NO checklist rules, submit is unaffected
//      (regression guard for [[feedback_env_gates]] — the gate must
//      never surprise a flow that had no rules).

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

describe('T1.1 — pre-auth checklist enforcement gate', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN = 'admin-cg@cg-test.local';

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
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      const tenant = await tx.tenant.create({
        data: { slug: 'tenant-cg', displayName: 'CG Test', lifecycleState: 'IN_SETUP' },
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
            'preauth.respond_query',
            'audit.view',
          ],
        },
      });
      const a = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: ADMIN,
          passwordHash,
          firstName: 'CG',
          lastName: 'Admin',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tenant.id, userId: a.id, roleId: adminRole.id },
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

  // Insert a platform-global checklist rule. documentChecklistRule has no
  // tenantId — it's master data — so this applies to every case in this
  // (isolated, per-file) Postgres container.
  async function addPreauthRule(documentType: string, required = true): Promise<void> {
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      await tx.documentChecklistRule.create({
        data: { phase: 'preauth', rail: 'nhcx', documentType, required },
      });
    });
  }

  async function clearChecklistRules(): Promise<void> {
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      await tx.documentChecklistRule.deleteMany({});
    });
  }

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

  async function caseAtDraftReady(
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

  async function uploadStub(
    cookies: string[],
    caseId: string,
    claimId: string,
    type: string,
    name: string,
  ): Promise<void> {
    const r = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/documents/upload-stub`)
      .set('Cookie', cookies)
      .send({
        documentType: type,
        originalFilename: name,
        contentType: 'application/pdf',
        sizeBytes: 1024,
      });
    expect(r.status).toBe(201);
  }

  function submit(
    cookies: string[],
    caseId: string,
    claimId: string,
  ): request.Test {
    return request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/submit`)
      .set('Cookie', cookies)
      .send({});
  }

  afterEach(async () => {
    await clearChecklistRules();
  });

  it('blocks submit with 412 + lists missing docs when a required preauth doc is absent', async () => {
    await addPreauthRule('preauth_form');
    await addPreauthRule('investigation_report');
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseAtDraftReady(cookies, 'MRN-CG-1');

    const res = await submit(cookies, caseId, claimId);
    expect(res.status).toBe(412);
    expect(res.body.code).toBe('PREAUTH_DOCUMENTS_INCOMPLETE');
    expect(res.body.errors.documents).toEqual(
      expect.arrayContaining(['investigation_report', 'preauth_form']),
    );
  });

  it('clears the gate once the missing documents are uploaded', async () => {
    await addPreauthRule('preauth_form');
    await addPreauthRule('investigation_report');
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseAtDraftReady(cookies, 'MRN-CG-2');

    // Upload only one — still blocked, and the satisfied one drops off
    // the missing list.
    await uploadStub(cookies, caseId, claimId, 'preauth_form', 'pf.pdf');
    const partial = await submit(cookies, caseId, claimId);
    expect(partial.status).toBe(412);
    expect(partial.body.errors.documents).toEqual(['investigation_report']);

    // Upload the second — gate clears, submit goes through.
    await uploadStub(cookies, caseId, claimId, 'investigation_report', 'inv.pdf');
    const ok = await submit(cookies, caseId, claimId);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('PREAUTH_SUBMITTED');
  });

  it('non-required checklist items never block submit', async () => {
    await addPreauthRule('OT_notes', false);
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseAtDraftReady(cookies, 'MRN-CG-3');
    const ok = await submit(cookies, caseId, claimId);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('PREAUTH_SUBMITTED');
  });

  it('vacuous pass: with no checklist rules the gate is a no-op', async () => {
    // No addPreauthRule call — resolveChecklist returns [].
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseAtDraftReady(cookies, 'MRN-CG-4');
    const ok = await submit(cookies, caseId, claimId);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('PREAUTH_SUBMITTED');
  });
});
