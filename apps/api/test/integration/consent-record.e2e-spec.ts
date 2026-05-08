// Slice BT — DPDP §6 / Rule 8 consent record + access-ledger binding e2e canary.
//
//   1. POST /consents grants a record; status='granted', audit row written.
//   2. GET /consents lists rows; filters by patientId / type / status.
//   3. POST /consents/:id/withdraw flips to withdrawn; second withdraw → 422.
//   4. requireConsent throws when no active grant; returns row when active.
//   5. Active query excludes expired (expiresAt in past) and withdrawn rows.
//   6. PatientService.getDecrypted with ctx.consentGrantId records the
//      binding into data_access_event.consentGrantId.
//   7. Reader without consent.view permission cannot list (403).
//   8. Cross-tenant GET on tenant B's record under tenant A's session
//      → 422 (RLS canary).

import { generateKeyPairSync } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { argon2id, hash } from 'argon2';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ConsentService } from '../../src/modules/consent/consent.service';
import { PatientService } from '../../src/modules/patient';
import { startPostgres, type PgHandles } from '../setup/postgres-container';

jest.setTimeout(180_000);

describe('Slice BT — consent record + binding', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;
  let consents: ConsentService;
  let patients: PatientService;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN_A = 'admin-bt-a@bt-test.local';
  const READER_A = 'reader-bt-a@bt-test.local';
  const ADMIN_B = 'admin-bt-b@bt-test.local';
  let tenantAId: string;
  let tenantBId: string;
  let actorAId: string;

  const evidence = {
    noticeText: 'You authorise the hospital to share your data with NHCX participants for claims processing.',
    acknowledgedVia: 'in_person_signature',
    locales: ['en-IN'],
  };

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

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const tA = await tx.tenant.create({
        data: { slug: 'tenant-bt-a', displayName: 'BT A', lifecycleState: 'IN_SETUP' },
      });
      tenantAId = tA.id;
      const tB = await tx.tenant.create({
        data: { slug: 'tenant-bt-b', displayName: 'BT B', lifecycleState: 'IN_SETUP' },
      });
      tenantBId = tB.id;
      const adminRoleA = await tx.role.create({
        data: {
          tenantId: tA.id,
          name: 'tenant_admin',
          permissions: ['consent.view', 'consent.manage'],
        },
      });
      const readerRoleA = await tx.role.create({
        data: { tenantId: tA.id, name: 'reader', permissions: ['case.view'] },
      });
      const adminRoleB = await tx.role.create({
        data: {
          tenantId: tB.id,
          name: 'tenant_admin',
          permissions: ['consent.view', 'consent.manage'],
        },
      });
      const ua = await tx.user.create({
        data: {
          tenantId: tA.id, email: ADMIN_A, passwordHash,
          firstName: 'A', lastName: 'Admin', status: 'active',
        },
      });
      actorAId = ua.id;
      await tx.userRole.create({
        data: { tenantId: tA.id, userId: ua.id, roleId: adminRoleA.id },
      });
      const ur = await tx.user.create({
        data: {
          tenantId: tA.id, email: READER_A, passwordHash,
          firstName: 'A', lastName: 'Reader', status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tA.id, userId: ur.id, roleId: readerRoleA.id },
      });
      const ub = await tx.user.create({
        data: {
          tenantId: tB.id, email: ADMIN_B, passwordHash,
          firstName: 'B', lastName: 'Admin', status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tB.id, userId: ub.id, roleId: adminRoleB.id },
      });
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.use(cookieParser());
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();
    consents = app.get(ConsentService);
    patients = app.get(PatientService);
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

  async function seedPatient(tenantId: string, name: string): Promise<string> {
    return migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      const p = await tx.patient.create({
        data: {
          tenantId,
          fullName: name,
          aadhaarCipher: 'cipher-aadhaar',
          aadhaarKeyVersion: 'v1',
          mobileCipher: 'cipher-mobile',
          mobileKeyVersion: 'v1',
        },
        select: { id: true },
      });
      return p.id;
    });
  }

  it('POST /consents grants a record with status=granted', async () => {
    const cookies = await loginAs(ADMIN_A);
    const patientId = await seedPatient(tenantAId, 'BT Grant Patient');
    const r = await request(app.getHttpServer())
      .post('/consents')
      .set('Cookie', cookies)
      .send({
        patientId,
        consentType: 'nhcx_processing',
        dataCategories: ['aadhaar', 'mobile'],
        purposes: ['eligibility.verify', 'preauth.submit'],
        lawfulBasis: 'consent',
        source: 'in_person',
        evidence,
      });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('granted');
    expect(r.body.consentType).toBe('nhcx_processing');
    expect(r.body.lawfulBasis).toBe('consent');
    expect(r.body.dataCategories).toEqual(['aadhaar', 'mobile']);
    expect(r.body.purposes).toEqual(['eligibility.verify', 'preauth.submit']);
    expect(r.body.capturedByUserId).toBe(actorAId);
  });

  it('GET /consents filters by patient + status', async () => {
    const cookies = await loginAs(ADMIN_A);
    const patientId = await seedPatient(tenantAId, 'Filter Patient');
    await request(app.getHttpServer())
      .post('/consents')
      .set('Cookie', cookies)
      .send({
        patientId,
        consentType: 'analytics',
        dataCategories: ['aggregate_only'],
        purposes: ['internal_analytics'],
        lawfulBasis: 'consent',
        source: 'in_person',
        evidence,
      });

    const list = await request(app.getHttpServer())
      .get(`/consents?patientId=${patientId}&status=granted`)
      .set('Cookie', cookies);
    expect(list.status).toBe(200);
    expect(list.body.rows.length).toBe(1);
    expect(list.body.rows[0].consentType).toBe('analytics');
  });

  it('withdraw flips status to withdrawn; second withdraw → 422', async () => {
    const cookies = await loginAs(ADMIN_A);
    const patientId = await seedPatient(tenantAId, 'Withdraw Patient');
    const grant = await request(app.getHttpServer())
      .post('/consents')
      .set('Cookie', cookies)
      .send({
        patientId,
        consentType: 'communication',
        dataCategories: ['mobile'],
        purposes: ['sms_reminders'],
        lawfulBasis: 'consent',
        source: 'in_person',
        evidence,
      });
    expect(grant.status).toBe(200);
    const id = grant.body.id;

    const withdraw = await request(app.getHttpServer())
      .post(`/consents/${id}/withdraw`)
      .set('Cookie', cookies)
      .send({ reason: 'Patient requested withdrawal at follow-up visit.' });
    expect(withdraw.status).toBe(200);
    expect(withdraw.body.status).toBe('withdrawn');
    expect(withdraw.body.withdrawalReason).toContain('Patient requested withdrawal');
    expect(withdraw.body.withdrawnAt).not.toBeNull();

    const second = await request(app.getHttpServer())
      .post(`/consents/${id}/withdraw`)
      .set('Cookie', cookies)
      .send({ reason: 'Cannot withdraw again.' });
    expect(second.status).toBe(422);
  });

  it('requireConsent throws when no active grant; returns row when active', async () => {
    const patientId = await seedPatient(tenantAId, 'Require Patient');
    // No grant yet → throws.
    await expect(
      consents.requireConsent(tenantAId, patientId, 'pmjay_processing'),
    ).rejects.toThrow();

    // Grant + retry.
    const cookies = await loginAs(ADMIN_A);
    await request(app.getHttpServer())
      .post('/consents')
      .set('Cookie', cookies)
      .send({
        patientId,
        consentType: 'pmjay_processing',
        dataCategories: ['aadhaar'],
        purposes: ['preauth.submit'],
        lawfulBasis: 'consent',
        source: 'in_person',
        evidence,
      });
    const found = await consents.requireConsent(tenantAId, patientId, 'pmjay_processing');
    expect(found).not.toBeNull();
    expect(found.consentType).toBe('pmjay_processing');
  });

  it('findActiveFor excludes expired and withdrawn rows', async () => {
    const cookies = await loginAs(ADMIN_A);
    const patientId = await seedPatient(tenantAId, 'Active Patient');

    // Past-expiry grant.
    const past = await request(app.getHttpServer())
      .post('/consents')
      .set('Cookie', cookies)
      .send({
        patientId,
        consentType: 'analytics',
        dataCategories: ['aggregate_only'],
        purposes: ['internal_analytics'],
        lawfulBasis: 'consent',
        source: 'in_person',
        evidence,
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      });
    expect(past.status).toBe(200);

    // Active grant should not exist.
    const noneActive = await consents.findActiveFor(tenantAId, patientId, 'analytics');
    expect(noneActive).toBeNull();

    // Add a non-expiring grant; should now find it.
    await request(app.getHttpServer())
      .post('/consents')
      .set('Cookie', cookies)
      .send({
        patientId,
        consentType: 'analytics',
        dataCategories: ['aggregate_only'],
        purposes: ['internal_analytics'],
        lawfulBasis: 'consent',
        source: 'in_person',
        evidence,
      });
    const active = await consents.findActiveFor(tenantAId, patientId, 'analytics');
    expect(active).not.toBeNull();

    // Withdraw it → should not find it anymore.
    await request(app.getHttpServer())
      .post(`/consents/${active!.id}/withdraw`)
      .set('Cookie', cookies)
      .send({ reason: 'Test withdrawal for filtering.' });
    const noneAfterWithdraw = await consents.findActiveFor(tenantAId, patientId, 'analytics');
    expect(noneAfterWithdraw).toBeNull();
  });

  it('PatientService.getDecrypted threads consentGrantId into data_access_event', async () => {
    const cookies = await loginAs(ADMIN_A);
    const patientId = await seedPatient(tenantAId, 'Binding Patient');
    const grant = await request(app.getHttpServer())
      .post('/consents')
      .set('Cookie', cookies)
      .send({
        patientId,
        consentType: 'nhcx_processing',
        dataCategories: ['aadhaar', 'mobile'],
        purposes: ['eligibility.verify'],
        lawfulBasis: 'consent',
        source: 'in_person',
        evidence,
      });
    expect(grant.status).toBe(200);
    const consentGrantId = grant.body.id as string;

    try {
      await patients.getDecrypted(tenantAId, patientId, {
        actorUserId: actorAId,
        actorType: 'user',
        purpose: 'eligibility.verify',
        consentGrantId,
      });
    } catch {
      // Expected — fake ciphertext won't decrypt. Access log is
      // still written before the decryption attempt fails.
    }

    // Allow the fire-and-forget access-log write to settle.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const events = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantAId}, true)`);
      return tx.dataAccessEvent.findMany({
        where: { tenantId: tenantAId, resourceType: 'patient', resourceId: patientId },
        select: { consentGrantId: true, action: true, purpose: true },
      });
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.consentGrantId).toBe(consentGrantId);
    expect(events[0]!.purpose).toBe('eligibility.verify');
  });

  it('reader without consent.view → 403', async () => {
    const cookies = await loginAs(READER_A);
    const r = await request(app.getHttpServer()).get('/consents').set('Cookie', cookies);
    expect(r.status).toBe(403);
  });

  it('cross-tenant GET on tenant B record under tenant A → 422 (RLS canary)', async () => {
    const bCookies = await loginAs(ADMIN_B);
    const patientB = await seedPatient(tenantBId, 'B Patient');
    const filed = await request(app.getHttpServer())
      .post('/consents')
      .set('Cookie', bCookies)
      .send({
        patientId: patientB,
        consentType: 'nhcx_processing',
        dataCategories: ['aadhaar'],
        purposes: ['eligibility.verify'],
        lawfulBasis: 'consent',
        source: 'in_person',
        evidence,
      });
    expect(filed.status).toBe(200);

    const aCookies = await loginAs(ADMIN_A);
    const cross = await request(app.getHttpServer())
      .get(`/consents/${filed.body.id}`)
      .set('Cookie', aCookies);
    expect(cross.status).toBe(422);
  });
});
