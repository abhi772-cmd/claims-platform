// Slice AZ integration test — operator-facing presigned download URL.
//
// Boots with STORAGE_MODE=stub so the StubStorageAdapter returns a
// `stub://` URL; the test asserts the wire-up + RBAC + scope guards
// (cross-claim → 422) without needing MinIO. The S3 path is
// exercised at the unit level by the SDK's signed-URL machinery.

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

describe('Slice AZ — GET /documents/:id/download-url', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN = 'admin-dl@dl-test.local';

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
        data: { slug: 'tenant-dl', displayName: 'DL', lifecycleState: 'IN_SETUP' },
      });
      const adminRole = await tx.role.create({
        data: {
          tenantId: tenant.id,
          name: 'tenant_admin',
          permissions: ['case.create', 'case.view'],
        },
      });
      const a = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: ADMIN,
          passwordHash,
          firstName: 'DL',
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
    await pg?.shutdown();
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

  async function uploadDoc(
    cookies: string[],
    mrn: string,
  ): Promise<{ caseId: string; claimId: string; documentId: string }> {
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
    const upload = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/documents/upload-stub`)
      .set('Cookie', cookies)
      .send({
        documentType: 'EOB',
        originalFilename: 'eob.pdf',
        contentType: 'application/pdf',
        sizeBytes: 4096,
      });
    expect(upload.status).toBe(201);
    return { caseId, claimId, documentId: upload.body.document.id as string };
  }

  it('returns the stub:// URL for a completed scan-clean document', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId, documentId } = await uploadDoc(cookies, 'MRN-DL-1');
    const res = await request(app.getHttpServer())
      .get(`/cases/${caseId}/claims/${claimId}/documents/${documentId}/download-url`)
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^stub:\/\/claims-stub\//);
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('cross-claim documentId → 422', async () => {
    const cookies = await loginAs(ADMIN);
    const a = await uploadDoc(cookies, 'MRN-DL-2A');
    const b = await uploadDoc(cookies, 'MRN-DL-2B');
    const res = await request(app.getHttpServer())
      .get(`/cases/${a.caseId}/claims/${a.claimId}/documents/${b.documentId}/download-url`)
      .set('Cookie', cookies);
    expect(res.status).toBe(422);
  });

  it("?filename= override doesn't change wire-up (stub URL stays canonical)", async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId, documentId } = await uploadDoc(cookies, 'MRN-DL-3');
    const res = await request(app.getHttpServer())
      .get(`/cases/${caseId}/claims/${claimId}/documents/${documentId}/download-url`)
      .query({ filename: 'patient-eob.pdf' })
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    // The stub doesn't honour ContentDisposition; we just assert the
    // override doesn't crash the request. Real-S3 behaviour is
    // exercised at the SDK level — getSignedUrl encodes the
    // ResponseContentDisposition param into the URL.
    expect(res.body.url).toMatch(/^stub:\/\//);
  });
});
