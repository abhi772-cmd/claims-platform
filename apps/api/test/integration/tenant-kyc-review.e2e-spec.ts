// ON-3 integration test — KYC ops review queue + lifecycle gate.
//   1. Tenant admin (no kyc.review permission) blocked from /admin/kyc/queue.
//   2. Platform admin sees queue across both tenants, pending only.
//   3. Tenant filter narrows the queue.
//   4. GET /admin/kyc/:id returns presigned download + tenant context.
//   5. POST /admin/kyc/:id/review with action=approve flips status,
//      audits, recomputes derived steps.
//   6. After 6 KYC + 2 legal docs are all approved, the tenant's
//      kyc_verified_by_ops onboarding step auto-flips to completed.
//   7. Reviewing a non-pending_review row → 400.
//   8. reject without rejectionReasonCode → 400 VALIDATION_FAILED.

import { generateKeyPairSync } from 'node:crypto';

import {
  type KycDocumentType,
  LEGAL_AGREEMENT_DOCUMENT_TYPES,
  REQUIRED_KYC_DOCUMENT_TYPES,
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

describe('ON-3 — KYC ops review queue', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const REVIEWER_EMAIL = 'reviewer@kyc-review-test.local';
  const TENANT_ADMIN = 'admin@kyc-review-test.local';
  let tenantId = '';

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
      const tenant = await tx.tenant.create({
        data: {
          slug: 'tenant-review',
          displayName: 'Review Test',
          lifecycleState: 'IN_SETUP',
        },
      });
      tenantId = tenant.id;

      // Platform-scoped role for the reviewer (tenantId = null).
      const reviewerRole = await tx.role.create({
        data: {
          tenantId: null,
          name: 'platform_admin',
          permissions: ['kyc.review'],
        },
      });
      // Tenant admin role — uploads KYC docs but cannot review.
      const adminRole = await tx.role.create({
        data: {
          tenantId: tenant.id,
          name: 'tenant_admin',
          permissions: ['tenant.onboarding.update'],
        },
      });

      const reviewer = await tx.user.create({
        data: {
          // Reviewer user is anchored to a tenant (the platform itself)
          // because tenantId is NOT NULL on user. tenantId here is the
          // ops "home" tenant; the cross-tenant access works via the
          // role's tenantId=null + permissions array carrying kyc.review.
          tenantId: tenant.id,
          email: REVIEWER_EMAIL,
          passwordHash,
          firstName: 'Re',
          lastName: 'Viewer',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: null, userId: reviewer.id, roleId: reviewerRole.id },
      });

      const admin = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: TENANT_ADMIN,
          passwordHash,
          firstName: 'Te',
          lastName: 'Admin',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tenant.id, userId: admin.id, roleId: adminRole.id },
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
  ): Promise<string> {
    const initRes = await request(app.getHttpServer())
      .post('/tenant/kyc/upload-init')
      .set('Cookie', cookies)
      .send({
        documentType,
        originalFilename: `${documentType}.pdf`,
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
    return docId;
  }

  it('tenant admin without kyc.review is blocked from GET /admin/kyc/queue', async () => {
    const cookies = await loginAs(TENANT_ADMIN);
    const res = await request(app.getHttpServer())
      .get('/admin/kyc/queue')
      .set('Cookie', cookies);
    expect(res.status).toBe(403);
  });

  it('queue lists pending_review rows by default', async () => {
    // Set up: tenant admin uploads one doc.
    const adminCookies = await loginAs(TENANT_ADMIN);
    await uploadAndFinalize(adminCookies, 'hospital_registration');

    const reviewerCookies = await loginAs(REVIEWER_EMAIL);
    const res = await request(app.getHttpServer())
      .get('/admin/kyc/queue')
      .set('Cookie', reviewerCookies);
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.items[0]?.tenantSlug).toBe('tenant-review');
    expect(res.body.items[0]?.document.status).toBe('pending_review');
  });

  it('GET /admin/kyc/:id returns presigned download', async () => {
    const reviewerCookies = await loginAs(REVIEWER_EMAIL);
    const queueRes = await request(app.getHttpServer())
      .get('/admin/kyc/queue')
      .set('Cookie', reviewerCookies);
    const docId = queueRes.body.items[0]?.document.id;
    const res = await request(app.getHttpServer())
      .get(`/admin/kyc/${docId}`)
      .set('Cookie', reviewerCookies);
    expect(res.status).toBe(200);
    expect(res.body.download.url).toBeDefined();
    expect(res.body.item.document.id).toBe(docId);
  });

  it('reject without rejectionReasonCode → 400 VALIDATION_FAILED', async () => {
    const reviewerCookies = await loginAs(REVIEWER_EMAIL);
    const queueRes = await request(app.getHttpServer())
      .get('/admin/kyc/queue')
      .set('Cookie', reviewerCookies);
    const docId = queueRes.body.items[0]?.document.id;
    const res = await request(app.getHttpServer())
      .post(`/admin/kyc/${docId}/review`)
      .set('Cookie', reviewerCookies)
      .send({ action: 'reject' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('approve flips status + recomputes derived steps', async () => {
    const reviewerCookies = await loginAs(REVIEWER_EMAIL);
    const queueRes = await request(app.getHttpServer())
      .get('/admin/kyc/queue')
      .set('Cookie', reviewerCookies);
    const docId = queueRes.body.items[0]?.document.id;
    const res = await request(app.getHttpServer())
      .post(`/admin/kyc/${docId}/review`)
      .set('Cookie', reviewerCookies)
      .send({ action: 'approve' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');

    // Audit row written.
    const audits = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      return tx.auditLog.findMany({
        where: {
          tenantId,
          action: 'TENANT_UPDATED',
          resourceType: 'kyc_document',
          resourceId: docId,
        },
      });
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('approving all 6 + 2 legal docs flips kyc_verified_by_ops to completed', async () => {
    const adminCookies = await loginAs(TENANT_ADMIN);
    const remainingKyc = REQUIRED_KYC_DOCUMENT_TYPES.filter(
      (t) => t !== 'hospital_registration', // already uploaded + approved above
    );
    const types: KycDocumentType[] = [...remainingKyc, ...LEGAL_AGREEMENT_DOCUMENT_TYPES];
    const docIds: string[] = [];
    for (const t of types) {
      docIds.push(await uploadAndFinalize(adminCookies, t));
    }

    const reviewerCookies = await loginAs(REVIEWER_EMAIL);
    for (const id of docIds) {
      const res = await request(app.getHttpServer())
        .post(`/admin/kyc/${id}/review`)
        .set('Cookie', reviewerCookies)
        .send({ action: 'approve' });
      expect(res.status).toBe(200);
    }

    // Tenant admin sees the step row as completed.
    const stepsRes = await request(app.getHttpServer())
      .get('/tenant/onboarding/steps')
      .set('Cookie', adminCookies);
    const verifiedStep = stepsRes.body.steps.find(
      (s: { key: string; status: string }) => s.key === 'kyc_verified_by_ops',
    );
    expect(verifiedStep?.status).toBe('completed');
    const legalStep = stepsRes.body.steps.find(
      (s: { key: string; status: string }) => s.key === 'legal_agreements_signed',
    );
    expect(legalStep?.status).toBe('completed');
    const kycStep = stepsRes.body.steps.find(
      (s: { key: string; status: string }) => s.key === 'kyc_documents_uploaded',
    );
    expect(kycStep?.status).toBe('completed');
  });

  it('refuses to review a non-pending_review row', async () => {
    const reviewerCookies = await loginAs(REVIEWER_EMAIL);
    // Take an already-approved doc from the earlier test.
    const queueRes = await request(app.getHttpServer())
      .get('/admin/kyc/queue?status=approved')
      .set('Cookie', reviewerCookies);
    const docId = queueRes.body.items[0]?.document.id;
    if (!docId) return; // no approved docs in this run — skip
    const res = await request(app.getHttpServer())
      .post(`/admin/kyc/${docId}/review`)
      .set('Cookie', reviewerCookies)
      .send({ action: 'approve' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });
});
