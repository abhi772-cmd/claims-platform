// Slice N integration test — payment / settlement / EOB.
//
//   1. /expect creates the settlement row + transitions to PAYMENT_PENDING.
//   2. Permission gate: a role without settlement.upload_eob can't record receipt.
//   3. Full-amount receipt: PAYMENT_RECEIVED + reconciliationStatus pending.
//   4. Reconcile: → PAYMENT_RECONCILED + auto_matched + claim.closed via close.
//   5. Short-paid path: receivedAmount < expected → SHORT_PAID + deductionAmount calc.
//   6. Write-off from SHORT_PAID → WRITTEN_OFF + close → CLOSED.
//   7. Cross-tenant /settlement read returns nothing.

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

describe('Slice N — payment + settlement + EOB', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN = 'admin-st@st-test.local';
  const ADMIN_B = 'admin-st-b@st-test.local';
  const READER = 'reader-st@st-test.local';

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
        data: { slug: 'tenant-st-a', displayName: 'ST A', lifecycleState: 'IN_SETUP' },
      });
      const tenantB = await tx.tenant.create({
        data: { slug: 'tenant-st-b', displayName: 'ST B', lifecycleState: 'IN_SETUP' },
      });
      const adminRole = await tx.role.create({
        data: {
          tenantId: tenantA.id, name: 'tenant_admin',
          permissions: [
            'case.create', 'case.view', 'case.assign',
            'preauth.draft', 'preauth.submit',
            'claim.draft', 'claim.submit',
            'settlement.upload_eob', 'settlement.categorize_deduct',
            'settlement.write_off',
            'audit.view',
          ],
        },
      });
      const readerRole = await tx.role.create({
        data: {
          tenantId: tenantA.id, name: 'reader',
          permissions: ['case.view'],
        },
      });
      const adminRoleB = await tx.role.create({
        data: {
          tenantId: tenantB.id, name: 'tenant_admin',
          permissions: [
            'case.create', 'case.view', 'case.assign',
            'preauth.draft', 'preauth.submit',
            'claim.draft', 'claim.submit',
            'settlement.upload_eob', 'settlement.categorize_deduct',
          ],
        },
      });
      const a = await tx.user.create({
        data: {
          tenantId: tenantA.id, email: ADMIN, passwordHash,
          firstName: 'ST', lastName: 'Admin', status: 'active',
        },
      });
      await tx.userRole.create({ data: { tenantId: tenantA.id, userId: a.id, roleId: adminRole.id } });
      const r = await tx.user.create({
        data: {
          tenantId: tenantA.id, email: READER, passwordHash,
          firstName: 'ST', lastName: 'Reader', status: 'active',
        },
      });
      await tx.userRole.create({ data: { tenantId: tenantA.id, userId: r.id, roleId: readerRole.id } });
      const b = await tx.user.create({
        data: {
          tenantId: tenantB.id, email: ADMIN_B, passwordHash,
          firstName: 'ST', lastName: 'AdminB', status: 'active',
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

  // Bring a fresh case all the way to CLAIM_APPROVED so we can settle.
  async function caseAtClaimApproved(
    cookies: string[],
    mrn: string,
    approvedAmount = 240_000,
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
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/decision`)
      .set('Cookie', cookies)
      .send({ kind: 'approved', approvedAmount: 250_000 });
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/discharge/initiate`)
      .set('Cookie', cookies)
      .send({});
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/documents/upload-stub`)
      .set('Cookie', cookies)
      .send({
        documentType: 'discharge_summary',
        originalFilename: 'ds.pdf',
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
      .send({ finalAmount: 250_000 });
    const dec = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/claim-submission/decision`)
      .set('Cookie', cookies)
      .send({ kind: 'approved', approvedAmount });
    expect(dec.body.status).toBe('CLAIM_APPROVED');
    return { caseId, claimId };
  }

  it('expect-payment creates settlement row + → PAYMENT_PENDING', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseAtClaimApproved(cookies, 'MRN-ST-1');
    const r = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/settlement/expect`)
      .set('Cookie', cookies)
      .send({ paymentMode: 'cashless_tpa' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('PAYMENT_PENDING');
    expect(r.body.settlement.expectedAmount).toBe(240_000);
    expect(r.body.settlement.reconciliationStatus).toBe('manual_match_pending');
  });

  it('reader cannot record receipt → 403', async () => {
    const adminCookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseAtClaimApproved(adminCookies, 'MRN-ST-2');
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/settlement/expect`)
      .set('Cookie', adminCookies)
      .send({ paymentMode: 'cashless_tpa' });

    const readerCookies = await loginAs(READER);
    const r = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/settlement/receipt`)
      .set('Cookie', readerCookies)
      .send({ receivedAmount: 240_000 });
    expect(r.status).toBe(403);
  });

  it('full-amount receipt → PAYMENT_RECEIVED; reconcile → PAYMENT_RECONCILED → CLOSED', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseAtClaimApproved(cookies, 'MRN-ST-3');
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/settlement/expect`)
      .set('Cookie', cookies)
      .send({ paymentMode: 'cashless_tpa' });

    const receipt = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/settlement/receipt`)
      .set('Cookie', cookies)
      .send({ receivedAmount: 240_000 });
    expect(receipt.status).toBe(200);
    expect(receipt.body.status).toBe('PAYMENT_RECEIVED');
    expect(receipt.body.settlement.deductionAmount).toBe(0);

    const reconcile = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/settlement/reconcile`)
      .set('Cookie', cookies)
      .send({ deductions: [] });
    expect(reconcile.status).toBe(200);
    expect(reconcile.body.status).toBe('PAYMENT_RECONCILED');
    expect(reconcile.body.settlement.reconciliationStatus).toBe('auto_matched');

    const close = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/settlement/close`)
      .set('Cookie', cookies)
      .send({});
    expect(close.status).toBe(200);
    expect(close.body.status).toBe('CLOSED');
    expect(close.body.settlement.closedAt).not.toBeNull();
  });

  it('short-paid path → SHORT_PAID + deductionAmount; write-off → WRITTEN_OFF → CLOSED', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseAtClaimApproved(cookies, 'MRN-ST-4');
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/settlement/expect`)
      .set('Cookie', cookies)
      .send({ paymentMode: 'reimbursement' });

    const short = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/settlement/receipt`)
      .set('Cookie', cookies)
      .send({
        receivedAmount: 200_000,
        shortPaymentReasons: ['policy sub-limit', 'co-pay'],
      });
    expect(short.body.status).toBe('SHORT_PAID');
    expect(short.body.settlement.deductionAmount).toBe(40_000);
    expect(short.body.settlement.reconciliationStatus).toBe('short_paid');
    expect(short.body.settlement.shortPaymentReasons).toEqual([
      'policy sub-limit',
      'co-pay',
    ]);

    const wo = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/settlement/write-off`)
      .set('Cookie', cookies)
      .send({ reason: 'Decision not appealable.' });
    expect(wo.status).toBe(200);
    expect(wo.body.status).toBe('WRITTEN_OFF');

    const close = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/settlement/close`)
      .set('Cookie', cookies)
      .send({});
    expect(close.body.status).toBe('CLOSED');
  });

  it('cross-tenant /settlement read returns nothing', async () => {
    const cookiesB = await loginAs(ADMIN_B);
    const { caseId, claimId } = await caseAtClaimApproved(cookiesB, 'MRN-ST-B');
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/settlement/expect`)
      .set('Cookie', cookiesB)
      .send({ paymentMode: 'cashless_tpa' });

    const cookiesA = await loginAs(ADMIN);
    const cross = await request(app.getHttpServer())
      .get(`/cases/${caseId}/claims/${claimId}/settlement`)
      .set('Cookie', cookiesA);
    expect([403, 422]).toContain(cross.status);
  });
});
