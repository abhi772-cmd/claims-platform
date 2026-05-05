// Slice M integration test — discharge + claim-submit phase end to end.
//
//   1. Permission gate: claim.draft can initiate discharge but not submit.
//   2. Document upload-stub creates a row, listable via GET /documents.
//   3. Discharge submit fails when no discharge_summary uploaded → 422.
//   4. Discharge submit happy path with one summary doc → ledger rows
//      written + claim moves DISCHARGE_PENDING → DISCHARGE_SUBMITTED.
//   5. Claim-submission start → CLAIM_DRAFTING; submit with finalAmount
//      transitions QUEUED → SUBMITTED with claimRefNum stamped.
//   6. Decision approved → CLAIM_APPROVED + approvedAmount stamped.
//   7. RLS canary: cross-tenant /documents read returns nothing.

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

describe('Slice M — discharge + claim submit phase', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN = 'admin-cs@cs-test.local';
  const DRAFTER = 'drafter-cs@cs-test.local';
  const ADMIN_B = 'admin-cs-b@cs-test.local';

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
      const tenantA = await tx.tenant.create({
        data: { slug: 'tenant-cs-a', displayName: 'CS A', lifecycleState: 'IN_SETUP' },
      });
      const tenantB = await tx.tenant.create({
        data: { slug: 'tenant-cs-b', displayName: 'CS B', lifecycleState: 'IN_SETUP' },
      });
      const adminRole = await tx.role.create({
        data: {
          tenantId: tenantA.id, name: 'tenant_admin',
          permissions: [
            'case.create', 'case.view', 'case.assign',
            'preauth.draft', 'preauth.submit', 'preauth.respond_query',
            'claim.draft', 'claim.submit',
            'audit.view',
          ],
        },
      });
      const drafterRole = await tx.role.create({
        data: {
          tenantId: tenantA.id, name: 'drafter',
          permissions: ['case.create', 'case.view', 'claim.draft'],
        },
      });
      const adminRoleB = await tx.role.create({
        data: {
          tenantId: tenantB.id, name: 'tenant_admin',
          permissions: [
            'case.create', 'case.view', 'case.assign',
            'preauth.draft', 'preauth.submit',
            'claim.draft', 'claim.submit',
          ],
        },
      });
      const a = await tx.user.create({
        data: {
          tenantId: tenantA.id, email: ADMIN, passwordHash,
          firstName: 'CS', lastName: 'Admin', status: 'active',
        },
      });
      await tx.userRole.create({ data: { tenantId: tenantA.id, userId: a.id, roleId: adminRole.id } });
      const d = await tx.user.create({
        data: {
          tenantId: tenantA.id, email: DRAFTER, passwordHash,
          firstName: 'CS', lastName: 'Drafter', status: 'active',
        },
      });
      await tx.userRole.create({ data: { tenantId: tenantA.id, userId: d.id, roleId: drafterRole.id } });
      const b = await tx.user.create({
        data: {
          tenantId: tenantB.id, email: ADMIN_B, passwordHash,
          firstName: 'CS', lastName: 'AdminB', status: 'active',
        },
      });
      await tx.userRole.create({ data: { tenantId: tenantB.id, userId: b.id, roleId: adminRoleB.id } });
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

  // Bring a fresh case all the way to PREAUTH_APPROVED so the discharge
  // phase can run.
  async function caseAtPreauthApproved(
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
        requestedAmount: 250_000,
      });
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/submit`)
      .set('Cookie', cookies)
      .send({});
    const dec = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/decision`)
      .set('Cookie', cookies)
      .send({ kind: 'approved', approvedAmount: 250_000 });
    expect(dec.body.status).toBe('PREAUTH_APPROVED');
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

  it('drafter can initiate discharge but cannot submit', async () => {
    const adminCookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseAtPreauthApproved(adminCookies, 'MRN-CS-1');

    const drafterCookies = await loginAs(DRAFTER);
    const initiate = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/discharge/initiate`)
      .set('Cookie', drafterCookies)
      .send({});
    expect(initiate.status).toBe(200);

    const submit = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/discharge/submit`)
      .set('Cookie', drafterCookies)
      .send({});
    expect(submit.status).toBe(403);
  });

  it('document upload-stub creates a row + listable', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseAtPreauthApproved(cookies, 'MRN-CS-2');
    await uploadStub(cookies, caseId, claimId, 'discharge_summary', 'discharge.pdf');
    const list = await request(app.getHttpServer())
      .get(`/cases/${caseId}/claims/${claimId}/documents`)
      .set('Cookie', cookies);
    expect(list.status).toBe(200);
    expect(list.body.documents.length).toBe(1);
    expect(list.body.documents[0].documentType).toBe('discharge_summary');
  });

  it('discharge submit without summary → 422', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseAtPreauthApproved(cookies, 'MRN-CS-3');
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/discharge/initiate`)
      .set('Cookie', cookies)
      .send({});
    const r = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/discharge/submit`)
      .set('Cookie', cookies)
      .send({});
    expect(r.status).toBe(422);
  });

  it('discharge happy path: claim → DISCHARGE_SUBMITTED + ledger rows', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseAtPreauthApproved(cookies, 'MRN-CS-4');
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/discharge/initiate`)
      .set('Cookie', cookies)
      .send({});
    await uploadStub(cookies, caseId, claimId, 'discharge_summary', 'ds.pdf');
    const r = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/discharge/submit`)
      .set('Cookie', cookies)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('DISCHARGE_SUBMITTED');

    const ledger = await request(app.getHttpServer())
      .get(`/cases/${caseId}/claims/${claimId}/integration-messages`)
      .set('Cookie', cookies);
    const dischargeRows = ledger.body.messages.filter(
      (m: { operation: string }) => m.operation === 'discharge.submit',
    );
    expect(dischargeRows.length).toBe(2);
  });

  it('claim submit happy path → CLAIM_SUBMITTED + claimRefNum stamped', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseAtPreauthApproved(cookies, 'MRN-CS-5');
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/discharge/initiate`)
      .set('Cookie', cookies)
      .send({});
    await uploadStub(cookies, caseId, claimId, 'discharge_summary', 'ds.pdf');
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/discharge/submit`)
      .set('Cookie', cookies)
      .send({});
    const start = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/claim-submission/start`)
      .set('Cookie', cookies)
      .send({});
    expect(start.body.status).toBe('CLAIM_DRAFTING');

    const submit = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/claim-submission/submit`)
      .set('Cookie', cookies)
      .send({ finalAmount: 245_000 });
    expect(submit.status).toBe(200);
    expect(submit.body.status).toBe('CLAIM_SUBMITTED');
    expect(submit.body.claimRefNum).toMatch(/^STUB-CL-/);
  });

  it('claim decision approved → CLAIM_APPROVED + approvedAmount stamped', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseAtPreauthApproved(cookies, 'MRN-CS-6');
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/discharge/initiate`)
      .set('Cookie', cookies)
      .send({});
    await uploadStub(cookies, caseId, claimId, 'discharge_summary', 'ds.pdf');
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
      .send({ finalAmount: 245_000 });

    const dec = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/claim-submission/decision`)
      .set('Cookie', cookies)
      .send({ kind: 'approved', approvedAmount: 240_000 });
    expect(dec.status).toBe(200);
    expect(dec.body.status).toBe('CLAIM_APPROVED');
    expect(dec.body.approvedAmount).toBe(240_000);
  });

  it('cross-tenant /documents read returns nothing', async () => {
    const cookiesB = await loginAs(ADMIN_B);
    const { caseId, claimId } = await caseAtPreauthApproved(cookiesB, 'MRN-CS-B');
    await uploadStub(cookiesB, caseId, claimId, 'discharge_summary', 'ds.pdf');

    const cookiesA = await loginAs(ADMIN);
    const cross = await request(app.getHttpServer())
      .get(`/cases/${caseId}/claims/${claimId}/documents`)
      .set('Cookie', cookiesA);
    expect([403, 422]).toContain(cross.status);
  });
});
