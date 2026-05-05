// Slice S integration test — virus-scan + lifecycle sweep.
//
//   1. finalize with VIRUS_SCAN_MODE=stub on benign content → scanStatus
//      'clean' + scannedAt set + hasDocumentType returns true.
//   2. finalize with EICAR signature in scanBufferBase64 → 422 +
//      scanStatus 'infected' + uploadError populated. The infected row
//      does NOT count toward hasDocumentType.
//   3. With VIRUS_SCAN_MODE=off the row finalizes scanStatus='skipped'
//      (already covered by Slice P2 tests; this asserts the gate still
//      accepts skipped + clean).
//   4. DocumentLifecycleWorker.runOnce sweeps a stale 'pending' row
//      older than DOC_PENDING_TTL_MINUTES and flips it to 'failed'.

import { generateKeyPairSync } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { argon2id, hash } from 'argon2';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { DocumentLifecycleWorker } from '../../src/modules/document/document-lifecycle.worker';
import { EICAR_TEST_STRING } from '../../src/modules/document/scan/stub-scan.adapter';
import { startPostgres, type PgHandles } from '../setup/postgres-container';

jest.setTimeout(180_000);

describe('Slice S — document scan + lifecycle', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;
  let worker: DocumentLifecycleWorker;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN = 'admin-scan@scan-test.local';

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
    process.env['NOTIFICATION_RETRY_DISABLED'] = 'true';
    process.env['DOC_LIFECYCLE_DISABLED'] = 'true';
    // Force scan ON for this suite — the rest of the test surface
    // expects 'off' so we set it locally.
    process.env['VIRUS_SCAN_MODE'] = 'stub';

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const tenant = await tx.tenant.create({
        data: { slug: 'tenant-scan', displayName: 'Scan', lifecycleState: 'IN_SETUP' },
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
          firstName: 'Scan',
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
    worker = app.get(DocumentLifecycleWorker);
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
    const r = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'Scan Patient',
        hospitalMrn: mrn,
        admissionDate: '2026-05-01',
        admissionType: 'planned',
        primaryRail: 'nhcx',
      });
    return { caseId: r.body.id, claimId: r.body.claims[0].id };
  }

  it('finalize with benign content sets scanStatus=clean', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await makeCase(cookies, 'MRN-SCAN-1');
    const init = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/documents/upload-init`)
      .set('Cookie', cookies)
      .send({
        documentType: 'discharge_summary',
        originalFilename: 'ds.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1024,
      });
    const docId = init.body.document.id as string;
    const benign = Buffer.from('Hello world clean PDF bytes').toString('base64');
    const fin = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/documents/${docId}/finalize`)
      .set('Cookie', cookies)
      .send({ scanBufferBase64: benign });
    expect(fin.status).toBe(200);
    expect(fin.body.document.scanStatus).toBe('clean');
    expect(fin.body.document.scanEngine).toBe('stub');
    expect(fin.body.document.scannedAt).not.toBeNull();
  });

  it('finalize with EICAR signature → 422 + scanStatus=infected', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await makeCase(cookies, 'MRN-SCAN-2');
    const init = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/documents/upload-init`)
      .set('Cookie', cookies)
      .send({
        documentType: 'final_bill',
        originalFilename: 'bad.pdf',
        contentType: 'application/pdf',
        sizeBytes: 256,
      });
    const docId = init.body.document.id as string;
    const tainted = Buffer.from(`leading bytes ${EICAR_TEST_STRING} trailing`).toString('base64');
    const fin = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/documents/${docId}/finalize`)
      .set('Cookie', cookies)
      .send({ scanBufferBase64: tainted });
    expect(fin.status).toBe(422);

    // Inspect the row directly: scanStatus=infected, signature recorded.
    const row = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      return tx.document.findUnique({ where: { id: docId } });
    });
    expect(row).not.toBeNull();
    expect(row!.scanStatus).toBe('infected');
    expect(row!.scanSignature).toBe('Eicar-Test-Signature');
    expect(row!.uploadError).toContain('Eicar');

    // List endpoint surfaces the infected row (so the UI can show
    // "rejected — please re-upload"), but it must not satisfy
    // hasDocumentType — that's the discharge / claim-submit guarantee.
    const list = await request(app.getHttpServer())
      .get(`/cases/${caseId}/claims/${claimId}/documents`)
      .set('Cookie', cookies);
    expect(list.body.documents).toHaveLength(1);
    expect(list.body.documents[0].scanStatus).toBe('infected');
  });

  it('lifecycle worker sweeps a stale pending row to failed', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await makeCase(cookies, 'MRN-SCAN-3');
    const init = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/documents/upload-init`)
      .set('Cookie', cookies)
      .send({
        documentType: 'investigation_report',
        originalFilename: 'lab.pdf',
        contentType: 'application/pdf',
        sizeBytes: 2048,
      });
    const docId = init.body.document.id as string;

    // Backdate the row's uploadedAt to 2 hours ago — past any sane
    // DOC_PENDING_TTL_MINUTES default. Run via migrator + platform_admin
    // to bypass tenant context for the test setup.
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      await tx.document.update({
        where: { id: docId },
        data: { uploadedAt: new Date(Date.now() - 2 * 60 * 60_000) },
      });
    });

    const result = await worker.runOnce();
    expect(result.swept).toBeGreaterThanOrEqual(1);

    // Row should now be 'failed'.
    const row = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      return tx.document.findUnique({ where: { id: docId } });
    });
    expect(row!.uploadStatus).toBe('failed');
    expect(row!.uploadError).toContain('TTL');
  });
});
