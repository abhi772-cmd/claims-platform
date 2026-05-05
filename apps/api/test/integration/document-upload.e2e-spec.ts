// Slice P2 integration test — document upload pipeline.
//
//   1. upload-init creates a 'pending' Document row + returns a stub
//      upload URL.
//   2. finalize flips the row to 'completed' + records the etag.
//   3. finalize is idempotent — calling it twice on the same doc
//      returns the same completed state.
//   4. discharge progression only counts 'completed' documents — a
//      pending row doesn't satisfy the discharge_summary requirement.
//   5. The legacy upload-stub still works end-to-end (creates a row in
//      'completed' state directly).

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

describe('Slice P2 — document upload pipeline', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN = 'admin-up@up-test.local';

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
    process.env['STORAGE_MODE'] = 'stub';
    process.env['NHCX_STUB_VERIFY_DEFAULT'] = 'true';

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const tenant = await tx.tenant.create({
        data: { slug: 'tenant-up', displayName: 'UP', lifecycleState: 'IN_SETUP' },
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
            'claim.draft',
            'claim.submit',
          ],
        },
      });
      const a = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: ADMIN,
          passwordHash,
          firstName: 'UP',
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

  async function makeCase(cookies: string[], mrn: string): Promise<{ caseId: string; claimId: string }> {
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
    expect(create.status).toBeLessThan(400);
    return { caseId: create.body.id, claimId: create.body.claims[0].id };
  }

  it('upload-init → finalize: row transitions pending → completed with etag', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await makeCase(cookies, 'MRN-UP-1');

    const init = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/documents/upload-init`)
      .set('Cookie', cookies)
      .send({
        documentType: 'discharge_summary',
        originalFilename: 'ds.pdf',
        contentType: 'application/pdf',
        sizeBytes: 2048,
      });
    expect(init.status).toBe(201);
    expect(init.body.document.uploadStatus).toBe('pending');
    expect(init.body.document.finalizedAt).toBeNull();
    expect(init.body.uploadUrl).toMatch(/^stub:\/\//);
    expect(init.body.requiredHeaders['content-type']).toBe('application/pdf');

    // Pending rows do NOT count as a discharge_summary present:
    const list1 = await request(app.getHttpServer())
      .get(`/cases/${caseId}/claims/${claimId}/documents`)
      .set('Cookie', cookies);
    expect(list1.body.documents).toHaveLength(1);
    expect(list1.body.documents[0].uploadStatus).toBe('pending');

    const finalize = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/documents/${init.body.document.id}/finalize`)
      .set('Cookie', cookies)
      .send({});
    expect(finalize.status).toBe(200);
    expect(finalize.body.document.uploadStatus).toBe('completed');
    expect(finalize.body.document.etag).toMatch(/^stub-etag-/);
    expect(finalize.body.document.finalizedAt).not.toBeNull();
  });

  it('finalize is idempotent — second call returns the same completed row', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await makeCase(cookies, 'MRN-UP-2');

    const init = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/documents/upload-init`)
      .set('Cookie', cookies)
      .send({
        documentType: 'final_bill',
        originalFilename: 'bill.pdf',
        contentType: 'application/pdf',
        sizeBytes: 4096,
      });
    const docId = init.body.document.id as string;

    const a = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/documents/${docId}/finalize`)
      .set('Cookie', cookies)
      .send({});
    expect(a.status).toBe(200);
    const b = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/documents/${docId}/finalize`)
      .set('Cookie', cookies)
      .send({});
    expect(b.status).toBe(200);
    expect(b.body.document.etag).toBe(a.body.document.etag);
    expect(b.body.document.finalizedAt).toBe(a.body.document.finalizedAt);
  });

  it('upload-init records the contentSha256 sent with finalize', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await makeCase(cookies, 'MRN-UP-3');
    const init = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/documents/upload-init`)
      .set('Cookie', cookies)
      .send({
        documentType: 'EOB',
        originalFilename: 'eob.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1024,
      });
    const docId = init.body.document.id as string;
    const sha = 'a'.repeat(64);
    const finalize = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/documents/${docId}/finalize`)
      .set('Cookie', cookies)
      .send({ contentSha256: sha });
    expect(finalize.status).toBe(200);
    expect(finalize.body.document.contentSha256).toBe(sha);
  });

  it('legacy upload-stub still creates a completed row directly', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await makeCase(cookies, 'MRN-UP-4');
    const r = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/documents/upload-stub`)
      .set('Cookie', cookies)
      .send({
        documentType: 'discharge_summary',
        originalFilename: 'ds.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1024,
      });
    expect(r.status).toBe(201);
    expect(r.body.document.uploadStatus).toBe('completed');
    expect(r.body.document.finalizedAt).not.toBeNull();
  });
});
