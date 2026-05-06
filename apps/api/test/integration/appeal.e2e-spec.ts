// Slice AH integration test — appeal lifecycle.
//
//   1. start: from PREAUTH_REJECTED → APPEAL_INITIATED, Appeal row
//      created with status='initiated', reason captured.
//   2. start from a non-appealable status → 422 (state-machine
//      rejection).
//   3. RBAC: a role without settlement.appeal can't call start.
//   4. submit: APPEAL_INITIATED → APPEAL_SUBMITTED, supportingDocuments
//      stamped, status='submitted'.
//   5. resolve approved: APPEAL_SUBMITTED → APPEAL_RESOLVED with
//      approvedAmount stamped on the claim + appeal row.
//   6. resolve rejected: same path, no approvedAmount required.
//   7. resolve without approvedAmount on approved kind → 422.

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

async function readClaim(
  prisma: PrismaClient,
  claimId: string,
): Promise<{ status: string; approvedAmount: number | null } | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
    );
    return tx.claim.findUnique({
      where: { id: claimId },
      select: { status: true, approvedAmount: true },
    });
  });
}

describe('Slice AH — appeal lifecycle', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN = 'admin-ap@ap-test.local';
  const READER = 'reader-ap@ap-test.local';

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
        data: { slug: 'tenant-ap', displayName: 'Appeal', lifecycleState: 'IN_SETUP' },
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
            'preauth.respond_query',
            'preauth.approve_internal',
            'settlement.appeal',
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
          firstName: 'AP',
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
          firstName: 'AP',
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

  // Drive a fresh case to PREAUTH_REJECTED (the simplest appealable
  // state — also covers the more common case at production).
  async function caseAtPreauthRejected(
    cookies: string[],
    mrn: string,
  ): Promise<{ caseId: string; claimId: string }> {
    const create = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'Appeal Patient',
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
    const dec = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/decision`)
      .set('Cookie', cookies)
      .send({ kind: 'rejected', reason: 'Not a covered procedure.' });
    expect(dec.status).toBe(200);
    expect(dec.body.status).toBe('PREAUTH_REJECTED');
    return { caseId, claimId };
  }

  it('start from PREAUTH_REJECTED → APPEAL_INITIATED', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseAtPreauthRejected(cookies, 'MRN-AP-1');
    const res = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/appeal/start`)
      .set('Cookie', cookies)
      .send({ reason: 'Procedure is covered under rider B.' });
    expect(res.status).toBe(200);
    expect(res.body.appeal.status).toBe('initiated');
    expect(res.body.appeal.reason).toBe('Procedure is covered under rider B.');
    expect(res.body.claimStatus).toBe('APPEAL_INITIATED');

    expect((await readClaim(migrator, claimId))?.status).toBe('APPEAL_INITIATED');
  });

  it('start from a non-appealable status → 422', async () => {
    const cookies = await loginAs(ADMIN);
    // Fresh INITIATED claim — not in PREAUTH_REJECTED / CLAIM_REJECTED /
    // SHORT_PAID, so appeal.started is rejected.
    const create = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'Appeal Patient 2',
        hospitalMrn: 'MRN-AP-2',
        admissionDate: '2026-05-01',
        admissionType: 'planned',
        primaryRail: 'nhcx',
      });
    const caseId = create.body.id as string;
    const claimId = create.body.claims[0].id as string;
    const res = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/appeal/start`)
      .set('Cookie', cookies)
      .send({ reason: 'Trying too early.' });
    expect(res.status).toBe(422);
  });

  it('reader without settlement.appeal → 403', async () => {
    const adminCookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseAtPreauthRejected(adminCookies, 'MRN-AP-3');
    const readerCookies = await loginAs(READER);
    const res = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/appeal/start`)
      .set('Cookie', readerCookies)
      .send({ reason: 'Reader trying.' });
    expect(res.status).toBe(403);
  });

  it('start → submit drives APPEAL_INITIATED → APPEAL_SUBMITTED', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseAtPreauthRejected(cookies, 'MRN-AP-4');
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/appeal/start`)
      .set('Cookie', cookies)
      .send({ reason: 'Rider B applies.' });
    const submit = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/appeal/submit`)
      .set('Cookie', cookies)
      .send({ supportingDocumentIds: [] });
    expect(submit.status).toBe(200);
    expect(submit.body.appeal.status).toBe('submitted');
    expect(submit.body.claimStatus).toBe('APPEAL_SUBMITTED');
  });

  it('submit twice (double-fire) is rejected', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseAtPreauthRejected(cookies, 'MRN-AP-5');
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/appeal/start`)
      .set('Cookie', cookies)
      .send({ reason: 'r' });
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/appeal/submit`)
      .set('Cookie', cookies)
      .send({});
    // Second submit — appeal status is already 'submitted'.
    const second = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/appeal/submit`)
      .set('Cookie', cookies)
      .send({});
    expect(second.status).toBe(422);
  });

  it('resolve approved stamps approvedAmount + auto-chains to PAYMENT_PENDING', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseAtPreauthRejected(cookies, 'MRN-AP-6');
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/appeal/start`)
      .set('Cookie', cookies)
      .send({ reason: 'r' });
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/appeal/submit`)
      .set('Cookie', cookies)
      .send({});
    const res = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/appeal/resolve`)
      .set('Cookie', cookies)
      .send({
        kind: 'partially_approved',
        approvedAmount: 175_000,
        note: 'Approved at the rider-B cap.',
      });
    expect(res.status).toBe(200);
    expect(res.body.appeal.status).toBe('resolved');
    expect(res.body.appeal.resolutionKind).toBe('partially_approved');
    expect(res.body.appeal.approvedAmount).toBe(175_000);
    // Slice AJ — claim is now PAYMENT_PENDING, not APPEAL_RESOLVED.
    // The auto-chain delegates to SettlementService.expectPayment.
    expect(res.body.claimStatus).toBe('PAYMENT_PENDING');

    const claim = await readClaim(migrator, claimId);
    expect(claim?.status).toBe('PAYMENT_PENDING');
    expect(claim?.approvedAmount).toBe(175_000);
  });

  it('resolve rejected does not auto-chain — claim stays at APPEAL_RESOLVED', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseAtPreauthRejected(cookies, 'MRN-AP-7');
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/appeal/start`)
      .set('Cookie', cookies)
      .send({ reason: 'r' });
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/appeal/submit`)
      .set('Cookie', cookies)
      .send({});
    const res = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/appeal/resolve`)
      .set('Cookie', cookies)
      .send({ kind: 'rejected', note: 'Final stand by payer.' });
    expect(res.status).toBe(200);
    expect(res.body.appeal.resolutionKind).toBe('rejected');
    expect(res.body.appeal.approvedAmount).toBeNull();
    // Slice AJ — rejected resolutions deliberately do NOT auto-chain.
    // The operator runs /settlement/write-off with a free-text reason
    // we won't invent for them.
    expect(res.body.claimStatus).toBe('APPEAL_RESOLVED');
    expect((await readClaim(migrator, claimId))?.status).toBe('APPEAL_RESOLVED');
  });

  it('resolve approved without approvedAmount → 422', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseAtPreauthRejected(cookies, 'MRN-AP-8');
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/appeal/start`)
      .set('Cookie', cookies)
      .send({ reason: 'r' });
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/appeal/submit`)
      .set('Cookie', cookies)
      .send({});
    const res = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/appeal/resolve`)
      .set('Cookie', cookies)
      .send({ kind: 'approved' });
    expect(res.status).toBe(422);
  });
});
