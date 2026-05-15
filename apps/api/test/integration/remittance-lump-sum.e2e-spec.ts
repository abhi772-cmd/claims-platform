// T3-2 integration test — lump-sum UTR allocation.
//
// Drives three claims through to PAYMENT_PENDING (settlement open with
// expected = 100_000 / 200_000 / 50_000 paise), then exercises:
//   1. GET /settlement/remittance/candidates — returns the three
//      candidates (manual_match_pending), ordered by expectedAmount desc.
//   2. POST /settlement/remittance/lump-sum happy path — splits
//      ₹3,50,000 (350_000 paise) across all three claims. Each
//      Settlement row picks up the shared bankTxnId; claims drive
//      payment.received; one claim is short-paid (45_000 of 50_000 expected)
//      and transitions through payment.short_paid.
//   3. POST /lump-sum — duplicate bankTxnId → 422 VALIDATION_FAILED.
//   4. POST /lump-sum — sum mismatch → 422 VALIDATION_FAILED.
//   5. RBAC: reader without settlement.upload_eob → 403 on both
//      candidates and lump-sum.

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

describe('T3-2 — lump-sum UTR allocation', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN = 'admin-ls@ls-test.local';
  const READER = 'reader-ls@ls-test.local';

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
    process.env['NHCX_STUB_VERIFY_DEFAULT'] = 'true';
    process.env['NOTIFICATION_RETRY_DISABLED'] = 'true';
    process.env['DOC_LIFECYCLE_DISABLED'] = 'true';

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const tenant = await tx.tenant.create({
        data: { slug: 'tenant-ls', displayName: 'Lump Sum', lifecycleState: 'IN_SETUP' },
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
            'preauth.approve_internal',
            'claim.draft',
            'claim.submit',
            'settlement.upload_eob',
            'settlement.categorize_deduct',
          ],
        },
      });
      const readerRole = await tx.role.create({
        data: {
          tenantId: tenant.id,
          name: 'reader',
          permissions: ['case.view'],
        },
      });
      const a = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: ADMIN,
          passwordHash,
          firstName: 'LS',
          lastName: 'Admin',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tenant.id, userId: a.id, roleId: adminRole.id },
      });
      const r = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: READER,
          passwordHash,
          firstName: 'LS',
          lastName: 'Reader',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tenant.id, userId: r.id, roleId: readerRole.id },
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

  async function caseAtPaymentPending(
    cookies: string[],
    mrn: string,
    finalAmount: number,
  ): Promise<{ caseId: string; claimId: string }> {
    const create = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: `Patient ${mrn}`,
        hospitalMrn: mrn,
        admissionDate: '2026-05-01',
        admissionType: 'planned',
        primaryRail: 'nhcx',
      });
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
        requestedAmount: finalAmount,
      });
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/submit`)
      .set('Cookie', cookies)
      .send({});
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/decision`)
      .set('Cookie', cookies)
      .send({ kind: 'approved', approvedAmount: finalAmount });
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/discharge/initiate`)
      .set('Cookie', cookies)
      .send({});
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/documents/upload-stub`)
      .set('Cookie', cookies)
      .send({
        documentType: 'discharge_summary',
        originalFilename: 'd.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1024,
      });
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
      .send({ finalAmount });
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/claim-submission/decision`)
      .set('Cookie', cookies)
      .send({ kind: 'approved', approvedAmount: finalAmount });
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/settlement/expect`)
      .set('Cookie', cookies)
      .send({ paymentMode: 'cashless_tpa' });
    return { caseId, claimId };
  }

  async function readSettlement(claimId: string): Promise<{
    bankTxnId: string | null;
    reconciliationStatus: string;
    receivedAmount: number | null;
  }> {
    return migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      return tx.settlement.findUniqueOrThrow({
        where: { claimId },
        select: { bankTxnId: true, reconciliationStatus: true, receivedAmount: true },
      });
    });
  }

  it('GET /candidates lists open settlements', async () => {
    const cookies = await loginAs(ADMIN);
    const c1 = await caseAtPaymentPending(cookies, 'MRN-LS-CAND-1', 100_000);
    const c2 = await caseAtPaymentPending(cookies, 'MRN-LS-CAND-2', 200_000);

    const res = await request(app.getHttpServer())
      .get('/settlement/remittance/candidates')
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.candidates)).toBe(true);
    const ids = res.body.candidates.map((c: { claimId: string }) => c.claimId);
    expect(ids).toContain(c1.claimId);
    expect(ids).toContain(c2.claimId);
    // Each candidate exposes expectedAmount + currentReceivedAmount=null.
    const sample = res.body.candidates.find((c: { claimId: string }) => c.claimId === c1.claimId);
    expect(sample.expectedAmount).toBe(100_000);
    expect(sample.currentReceivedAmount).toBeNull();
    expect(sample.reconciliationStatus).toBe('manual_match_pending');
  });

  it('happy path: allocate ₹3,50,000 across three claims (one short-paid)', async () => {
    const cookies = await loginAs(ADMIN);
    const c1 = await caseAtPaymentPending(cookies, 'MRN-LS-A1', 100_000);
    const c2 = await caseAtPaymentPending(cookies, 'MRN-LS-A2', 200_000);
    const c3 = await caseAtPaymentPending(cookies, 'MRN-LS-A3', 50_000);

    const res = await request(app.getHttpServer())
      .post('/settlement/remittance/lump-sum')
      .set('Cookie', cookies)
      .send({
        bankTxnId: 'HDFC-LUMP-001',
        totalAmount: 345_000,
        allocations: [
          { claimId: c1.claimId, allocatedAmount: 100_000 },
          { claimId: c2.claimId, allocatedAmount: 200_000 },
          { claimId: c3.claimId, allocatedAmount: 45_000 }, // short
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.bankTxnId).toBe('HDFC-LUMP-001');
    expect(res.body.appliedCount).toBe(3);
    expect(res.body.failedCount).toBe(0);
    expect(res.body.allocatedTotal).toBe(345_000);

    // Settlements all carry the same bankTxnId.
    const s1 = await readSettlement(c1.claimId);
    const s2 = await readSettlement(c2.claimId);
    const s3 = await readSettlement(c3.claimId);
    expect(s1.bankTxnId).toBe('HDFC-LUMP-001');
    expect(s2.bankTxnId).toBe('HDFC-LUMP-001');
    expect(s3.bankTxnId).toBe('HDFC-LUMP-001');

    // c1 + c2 are full-pay → manual_match_pending; c3 is short → short_paid.
    expect(s1.reconciliationStatus).toBe('manual_match_pending');
    expect(s2.reconciliationStatus).toBe('manual_match_pending');
    expect(s3.reconciliationStatus).toBe('short_paid');

    expect(s1.receivedAmount).toBe(100_000);
    expect(s3.receivedAmount).toBe(45_000);
  });

  it('rejects sum mismatch with VALIDATION_FAILED (422)', async () => {
    const cookies = await loginAs(ADMIN);
    const c1 = await caseAtPaymentPending(cookies, 'MRN-LS-VAR', 100_000);

    const res = await request(app.getHttpServer())
      .post('/settlement/remittance/lump-sum')
      .set('Cookie', cookies)
      .send({
        bankTxnId: 'HDFC-LUMP-VAR',
        totalAmount: 100_000,
        allocations: [{ claimId: c1.claimId, allocatedAmount: 90_000 }], // 10k short
      });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.errors?.allocations?.[0]).toMatch(/sum of allocations/i);
  });

  it('rejects duplicate bankTxnId with VALIDATION_FAILED (422)', async () => {
    const cookies = await loginAs(ADMIN);
    const c1 = await caseAtPaymentPending(cookies, 'MRN-LS-D1', 100_000);
    const c2 = await caseAtPaymentPending(cookies, 'MRN-LS-D2', 50_000);

    // First allocation succeeds.
    const first = await request(app.getHttpServer())
      .post('/settlement/remittance/lump-sum')
      .set('Cookie', cookies)
      .send({
        bankTxnId: 'DUP-TXN-001',
        totalAmount: 100_000,
        allocations: [{ claimId: c1.claimId, allocatedAmount: 100_000 }],
      });
    expect(first.status).toBe(200);

    // Re-using the same bankTxnId is rejected.
    const dup = await request(app.getHttpServer())
      .post('/settlement/remittance/lump-sum')
      .set('Cookie', cookies)
      .send({
        bankTxnId: 'DUP-TXN-001',
        totalAmount: 50_000,
        allocations: [{ claimId: c2.claimId, allocatedAmount: 50_000 }],
      });
    expect(dup.status).toBe(422);
    expect(dup.body.code).toBe('VALIDATION_FAILED');
    expect(dup.body.errors?.bankTxnId?.[0]).toMatch(/already applied/i);
  });

  it('reader without settlement.upload_eob → 403 on both endpoints', async () => {
    const cookies = await loginAs(READER);

    const candidates = await request(app.getHttpServer())
      .get('/settlement/remittance/candidates')
      .set('Cookie', cookies);
    expect(candidates.status).toBe(403);

    const allocate = await request(app.getHttpServer())
      .post('/settlement/remittance/lump-sum')
      .set('Cookie', cookies)
      .send({
        bankTxnId: 'RBAC-X',
        totalAmount: 100,
        allocations: [
          { claimId: '00000000-0000-0000-0000-000000000000', allocatedAmount: 100 },
        ],
      });
    expect(allocate.status).toBe(403);
  });
});
