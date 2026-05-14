// ON-2 integration test — KYC document upload lifecycle (docs/15 Stage 3).
//   1. Reader without tenant.onboarding.update blocked from GET /tenant/kyc.
//   2. Admin initial GET — no documents, requiredCoverageComplete=false.
//   3. Admin upload-init → row created in 'uploading' with stub URL.
//   4. Admin finalize → row flips to 'pending_review'; audit row written.
//   5. After uploading all 6 required types, requiredCoverageComplete=true.
//   6. Invalid content-type (text/plain) on upload-init → 400.
//   7. Oversize upload-init (sizeBytes > KYC_MAX_UPLOAD_BYTES) → 400.
//   8. Delete a pending_review row succeeds; coverage drops.
//   9. Cross-tenant: tenant B admin can't see tenant A's KYC rows.

import { generateKeyPairSync } from 'node:crypto';

import {
  KYC_MAX_UPLOAD_BYTES,
  REQUIRED_KYC_DOCUMENT_TYPES,
  type KycDocumentType,
} from '@claims/contracts';
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

describe('ON-2 — tenant KYC upload lifecycle', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN_A = 'admin-a@kyc-test.local';
  const READER_A = 'reader-a@kyc-test.local';
  const ADMIN_B = 'admin-b@kyc-test.local';
  let tenantAId = '';
  let tenantBId = '';

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
    process.env['JWT_ACCESS_TTL'] = '15m';
    process.env['JWT_REFRESH_TTL'] = '7d';
    process.env['COOKIE_DOMAIN'] = 'localhost';
    process.env['COOKIE_SECURE'] = 'false';
    process.env['COOKIE_SAMESITE'] = 'lax';
    process.env['LOG_LEVEL'] = 'warn';
    process.env['CORS_ORIGIN'] = 'http://localhost:3000';
    process.env['WEB_BASE_URL'] = 'http://localhost:3000';
    process.env['SMTP_HOST'] = '127.0.0.1';
    process.env['SMTP_PORT'] = '1';
    process.env['SMTP_FROM'] = 'no-reply@test';
    process.env['INVITE_TOKEN_TTL_HOURS'] = '168';
    process.env['INVITE_RESEND_LIMIT_PER_DAY'] = '3';
    process.env['PASSWORD_RESET_TOKEN_TTL_MINUTES'] = '30';
    process.env['PASSWORD_RESET_RATE_LIMIT_PER_DAY'] = '5';
    process.env['CONCURRENT_SESSION_LIMIT'] = '5';
    process.env['TRUSTED_DEVICE_TTL_DAYS'] = '30';
    process.env['DOCTOR_TOKEN_TTL_MINUTES'] = '10';
    process.env['HPR_STUB_OTP'] = '000000';
    process.env['STORAGE_MODE'] = 'stub';
    process.env['VIRUS_SCAN_MODE'] = 'off';

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const tenantA = await tx.tenant.create({
        data: { slug: 'tenant-kyc-a', displayName: 'KYC Test A', lifecycleState: 'IN_SETUP' },
      });
      tenantAId = tenantA.id;
      const tenantB = await tx.tenant.create({
        data: { slug: 'tenant-kyc-b', displayName: 'KYC Test B', lifecycleState: 'IN_SETUP' },
      });
      tenantBId = tenantB.id;

      const adminRoleA = await tx.role.create({
        data: {
          tenantId: tenantA.id,
          name: 'tenant_admin',
          permissions: ['tenant.onboarding.update'],
        },
      });
      const readerRoleA = await tx.role.create({
        data: { tenantId: tenantA.id, name: 'read_only', permissions: ['case.view'] },
      });
      const adminRoleB = await tx.role.create({
        data: {
          tenantId: tenantB.id,
          name: 'tenant_admin',
          permissions: ['tenant.onboarding.update'],
        },
      });

      const aA = await tx.user.create({
        data: {
          tenantId: tenantA.id,
          email: ADMIN_A,
          passwordHash,
          firstName: 'A',
          lastName: 'Admin',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tenantA.id, userId: aA.id, roleId: adminRoleA.id },
      });
      const rA = await tx.user.create({
        data: {
          tenantId: tenantA.id,
          email: READER_A,
          passwordHash,
          firstName: 'A',
          lastName: 'Reader',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tenantA.id, userId: rA.id, roleId: readerRoleA.id },
      });
      const aB = await tx.user.create({
        data: {
          tenantId: tenantB.id,
          email: ADMIN_B,
          passwordHash,
          firstName: 'B',
          lastName: 'Admin',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tenantB.id, userId: aB.id, roleId: adminRoleB.id },
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

  async function uploadAndFinalize(
    cookies: string[],
    documentType: KycDocumentType,
    filename = `${documentType}.pdf`,
  ): Promise<string> {
    const initRes = await request(app.getHttpServer())
      .post('/tenant/kyc/upload-init')
      .set('Cookie', cookies)
      .send({
        documentType,
        originalFilename: filename,
        contentType: 'application/pdf',
        sizeBytes: 1024,
      });
    expect(initRes.status).toBe(201);
    const docId = initRes.body.document.id as string;
    const finRes = await request(app.getHttpServer())
      .post(`/tenant/kyc/${docId}/finalize`)
      .set('Cookie', cookies)
      .send({});
    expect(finRes.status).toBe(200);
    expect(finRes.body.status).toBe('pending_review');
    return docId;
  }

  it('reader without tenant.onboarding.update is blocked from GET /tenant/kyc', async () => {
    const cookies = await loginAs(READER_A);
    const res = await request(app.getHttpServer())
      .get('/tenant/kyc')
      .set('Cookie', cookies);
    expect(res.status).toBe(403);
  });

  it('admin GET initially returns empty list, requiredCoverageComplete=false', async () => {
    const cookies = await loginAs(ADMIN_A);
    const res = await request(app.getHttpServer())
      .get('/tenant/kyc')
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.documents).toEqual([]);
    expect(res.body.requiredCoverageComplete).toBe(false);
    for (const t of REQUIRED_KYC_DOCUMENT_TYPES) {
      expect(res.body.requiredCoverage[t]).toBe(false);
    }
  });

  it('upload-init → finalize flips status to pending_review and audits', async () => {
    const cookies = await loginAs(ADMIN_A);
    const docId = await uploadAndFinalize(cookies, 'hospital_registration');

    const audits = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      return tx.auditLog.findMany({
        where: {
          tenantId: tenantAId,
          action: 'TENANT_UPDATED',
          resourceType: 'kyc_document',
          resourceId: docId,
        },
      });
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('uploading all six required types flips requiredCoverageComplete=true', async () => {
    const cookies = await loginAs(ADMIN_A);
    for (const t of REQUIRED_KYC_DOCUMENT_TYPES) {
      // hospital_registration already uploaded in the previous test.
      if (t === 'hospital_registration') continue;
      await uploadAndFinalize(cookies, t);
    }
    const res = await request(app.getHttpServer())
      .get('/tenant/kyc')
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.requiredCoverageComplete).toBe(true);
    for (const t of REQUIRED_KYC_DOCUMENT_TYPES) {
      expect(res.body.requiredCoverage[t]).toBe(true);
    }
  });

  it('invalid content-type on upload-init → 400 VALIDATION_FAILED', async () => {
    const cookies = await loginAs(ADMIN_A);
    const res = await request(app.getHttpServer())
      .post('/tenant/kyc/upload-init')
      .set('Cookie', cookies)
      .send({
        documentType: 'gst_certificate',
        originalFilename: 'x.txt',
        contentType: 'text/plain',
        sizeBytes: 100,
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('oversize upload-init → 400 VALIDATION_FAILED', async () => {
    const cookies = await loginAs(ADMIN_A);
    const res = await request(app.getHttpServer())
      .post('/tenant/kyc/upload-init')
      .set('Cookie', cookies)
      .send({
        documentType: 'gst_certificate',
        originalFilename: 'big.pdf',
        contentType: 'application/pdf',
        sizeBytes: KYC_MAX_UPLOAD_BYTES + 1,
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('delete on a pending_review row succeeds and drops coverage', async () => {
    const cookies = await loginAs(ADMIN_A);
    // Find the pan doc id from the list.
    const listRes = await request(app.getHttpServer())
      .get('/tenant/kyc')
      .set('Cookie', cookies);
    const pan = listRes.body.documents.find(
      (d: { documentType: string; id: string }) => d.documentType === 'pan',
    );
    expect(pan).toBeDefined();
    const delRes = await request(app.getHttpServer())
      .delete(`/tenant/kyc/${pan.id}`)
      .set('Cookie', cookies);
    expect(delRes.status).toBe(204);

    const afterRes = await request(app.getHttpServer())
      .get('/tenant/kyc')
      .set('Cookie', cookies);
    expect(afterRes.body.requiredCoverage.pan).toBe(false);
    expect(afterRes.body.requiredCoverageComplete).toBe(false);
  });

  it('cross-tenant: tenant B admin does not see tenant A KYC rows', async () => {
    const cookies = await loginAs(ADMIN_B);
    const res = await request(app.getHttpServer())
      .get('/tenant/kyc')
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.documents).toEqual([]);
    expect(tenantBId).not.toBe(tenantAId);
  });
});
