// Slice W integration test — real-mode storage end-to-end against
// MinIO. Exercises the production-shaped flow:
//   1. upload-init: server signs a PUT URL against the MinIO bucket.
//   2. client PUTs the bytes via the URL (using fetch, not the SDK,
//      to mirror what the browser will do).
//   3. finalize: server HEADs the object, captures etag + actual size,
//      flips the row to 'completed'.
// Plus the finalize-failure path: client never PUTs → server HEAD
// returns 404 → row flips to 'failed' + 422 surfaces to the caller.

import { generateKeyPairSync } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { argon2id, hash } from 'argon2';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { startMinio, type MinioHandles } from '../setup/minio-container';
import { startPostgres, type PgHandles } from '../setup/postgres-container';

jest.setTimeout(240_000);

describe('Slice W — real S3 (MinIO) upload pipeline', () => {
  let pg: PgHandles;
  let minio: MinioHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN = 'admin-s3@s3-test.local';

  beforeAll(async () => {
    [pg, minio] = await Promise.all([startPostgres(), startMinio()]);
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
    process.env['NOTIFICATION_RETRY_DISABLED'] = 'true';
    process.env['DOC_LIFECYCLE_DISABLED'] = 'true';
    // The real S3 wiring under test.
    process.env['STORAGE_MODE'] = 'real';
    process.env['OVH_S3_ENDPOINT'] = minio.endpoint;
    process.env['OVH_S3_REGION'] = minio.region;
    process.env['OVH_S3_BUCKET'] = minio.bucket;
    process.env['OVH_S3_ACCESS_KEY'] = minio.accessKey;
    process.env['OVH_S3_SECRET_KEY'] = minio.secretKey;
    process.env['S3_FORCE_PATH_STYLE'] = 'true';

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const tenant = await tx.tenant.create({
        data: { slug: 'tenant-s3', displayName: 'S3', lifecycleState: 'IN_SETUP' },
      });
      const role = await tx.role.create({
        data: {
          tenantId: tenant.id,
          name: 'tenant_admin',
          permissions: ['case.create', 'case.view'],
        },
      });
      const u = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: ADMIN,
          passwordHash,
          firstName: 'S3',
          lastName: 'Admin',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tenant.id, userId: u.id, roleId: role.id },
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
    await minio?.shutdown();
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
    const r = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'S3 Patient',
        hospitalMrn: mrn,
        admissionDate: '2026-05-01',
        admissionType: 'planned',
        primaryRail: 'nhcx',
      });
    return { caseId: r.body.id, claimId: r.body.claims[0].id };
  }

  it('init → PUT to S3 → finalize captures real etag + observed size', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await makeCase(cookies, 'MRN-S3-1');

    const init = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/documents/upload-init`)
      .set('Cookie', cookies)
      .send({
        documentType: 'discharge_summary',
        originalFilename: 'discharge.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1024,
      });
    expect(init.status).toBe(201);
    expect(init.body.uploadUrl).toMatch(/^http/); // not stub://
    expect(init.body.document.uploadStatus).toBe('pending');
    const docId = init.body.document.id as string;

    // Generate exactly the bytes we declared. The Content-Length header
    // matters — S3 SigV4 includes it in the signature when set on the
    // request. Sending different bytes with a wrong Content-Length
    // would cause a SignatureDoesNotMatch.
    const bytes = Buffer.alloc(1024);
    bytes.fill(0x42);
    const putRes = await fetch(init.body.uploadUrl, {
      method: 'PUT',
      headers: {
        'content-type': 'application/pdf',
        'content-length': String(bytes.length),
      },
      body: bytes,
    });
    expect(putRes.status).toBe(200);

    const finalize = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/documents/${docId}/finalize`)
      .set('Cookie', cookies)
      .send({});
    expect(finalize.status).toBe(200);
    expect(finalize.body.document.uploadStatus).toBe('completed');
    expect(finalize.body.document.etag).toMatch(/^[a-f0-9]+$/i);
    expect(finalize.body.document.etag.length).toBeGreaterThanOrEqual(8);
    expect(finalize.body.document.sizeBytes).toBe(1024);
    expect(finalize.body.document.finalizedAt).not.toBeNull();
  });

  it('finalize without uploading → S3 HEAD 404 → row flips to failed + 422', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await makeCase(cookies, 'MRN-S3-2');

    const init = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/documents/upload-init`)
      .set('Cookie', cookies)
      .send({
        documentType: 'final_bill',
        originalFilename: 'bill.pdf',
        contentType: 'application/pdf',
        sizeBytes: 512,
      });
    expect(init.status).toBe(201);
    const docId = init.body.document.id as string;

    // Skip the PUT entirely. finalize must surface the HEAD failure.
    const finalize = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/documents/${docId}/finalize`)
      .set('Cookie', cookies)
      .send({});
    expect(finalize.status).toBe(422);

    // The row should be 'failed' with uploadError populated. Read via
    // the migrator with platform_admin to bypass RLS for the assert.
    const row = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      return tx.document.findUnique({ where: { id: docId } });
    });
    expect(row).not.toBeNull();
    expect(row!.uploadStatus).toBe('failed');
    expect(row!.uploadError).toBeTruthy();
  });
});
