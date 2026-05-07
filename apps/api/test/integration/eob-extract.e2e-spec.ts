// Slice AW integration test — operator-triggered EOB OCR extraction
// at POST /cases/:c/claims/:cl/documents/:id/eob-extract.
//
// Boots with EOB_OCR_MODE=stub so the StubEobOcrAdapter handles
// requests; the test sends sentinel-pattern buffers (per
// STUB_EOB_SENTINELS) and asserts the extracted fields propagate
// through the full HTTP path. Stub-storage means the no-buffer
// fallback path returns `failed` — that's also exercised so the
// "operator forgot to upload bytes" UX is documented.

import { generateKeyPairSync } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { argon2id, hash } from 'argon2';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { STUB_EOB_SENTINELS } from '../../src/modules/eob-ocr';
import { startPostgres, type PgHandles } from '../setup/postgres-container';

jest.setTimeout(180_000);

describe('Slice AW — POST /documents/:id/eob-extract', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN = 'admin-eo@eo-test.local';

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
    process.env['EOB_OCR_MODE'] = 'stub';
    process.env['NHCX_STUB_VERIFY_DEFAULT'] = 'true';

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const tenant = await tx.tenant.create({
        data: { slug: 'tenant-eo', displayName: 'EOB Extract', lifecycleState: 'IN_SETUP' },
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
          firstName: 'EO',
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

  async function createDocAndGetIds(
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
    const documentId = upload.body.document.id as string;
    return { caseId, claimId, documentId };
  }

  it('inline buffer with short-paid sentinel → status=extracted with deduction line', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId, documentId } = await createDocAndGetIds(cookies, 'MRN-EO-1');
    const body = Buffer.from(
      `Header noise...\n${STUB_EOB_SENTINELS.short('STUB-CL-EO-1', 75_000, 100_000)}\nfooter`,
    );
    const res = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/documents/${documentId}/eob-extract`)
      .set('Cookie', cookies)
      .send({ bufferBase64: body.toString('base64') });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('extracted');
    expect(res.body.engine).toBe('stub');
    expect(res.body.fields.claimRefNum).toBe('STUB-CL-EO-1');
    expect(res.body.fields.receivedAmount).toBe(75_000);
    expect(res.body.fields.deductionAmount).toBe(25_000);
    expect(res.body.fields.deductions).toHaveLength(1);
    expect(res.body.fields.deductions[0].amount).toBe(25_000);
    expect(res.body.fields.shortPaymentReasons).toEqual(['Cap exceeded under rider B']);
  });

  it('inline buffer with clean sentinel → no deductions, full receivedAmount', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId, documentId } = await createDocAndGetIds(cookies, 'MRN-EO-2');
    const body = Buffer.from(STUB_EOB_SENTINELS.clean('STUB-CL-EO-2', 200_000));
    const res = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/documents/${documentId}/eob-extract`)
      .set('Cookie', cookies)
      .send({ bufferBase64: body.toString('base64') });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('extracted');
    expect(res.body.fields.claimRefNum).toBe('STUB-CL-EO-2');
    expect(res.body.fields.receivedAmount).toBe(200_000);
    expect(res.body.fields.deductionAmount).toBe(0);
    expect(res.body.fields.deductions).toEqual([]);
  });

  it('no buffer + stub storage → status=skipped (stub adapter declines bucket/key)', async () => {
    // The stub OCR adapter returns 'skipped' when handed only
    // (bucket, key); the real adapter will fetch via storage.getObject.
    // This test pins the operator-facing UX: forgetting to attach the
    // buffer surfaces a clear status, not a 500.
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId, documentId } = await createDocAndGetIds(cookies, 'MRN-EO-3');
    const res = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/documents/${documentId}/eob-extract`)
      .set('Cookie', cookies)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('skipped');
    expect(res.body.engine).toBe('stub');
  });

  it('cross-claim documentId → 422', async () => {
    const cookies = await loginAs(ADMIN);
    const a = await createDocAndGetIds(cookies, 'MRN-EO-4A');
    const b = await createDocAndGetIds(cookies, 'MRN-EO-4B');
    const res = await request(app.getHttpServer())
      .post(`/cases/${a.caseId}/claims/${a.claimId}/documents/${b.documentId}/eob-extract`)
      .set('Cookie', cookies)
      .send({ bufferBase64: Buffer.from('x').toString('base64') });
    expect(res.status).toBe(422);
  });
});
