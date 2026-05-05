// Slice F integration test — doctor short-token + HPR stub.
//   1. Non-permitted user cannot issue → 403 AUTH_INSUFFICIENT_PERMISSIONS.
//   2. Permitted user issues a token → 201, audit row written.
//   3. /preauth/doctor-tokens/:raw/preview returns the case context.
//   4. /sign with bogus HPR → 422 AUTH_HPR_VERIFICATION_FAILED + audit row.
//   5. /sign with valid HPR + OTP → 200 + DOCTOR_SIGNED audit row.
//   6. Replay of same raw token → AUTH_DOCTOR_TOKEN_INVALID (single-use).
//   7. Expired token (artificially aged) → AUTH_DOCTOR_TOKEN_EXPIRED.

import { createHash, generateKeyPairSync } from 'node:crypto';

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

describe('Slice F — doctor short-token + HPR stub', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const REQUESTER_EMAIL = 'requester@doc-test.local';
  const READER_EMAIL = 'reader@doc-test.local';
  const DOCTOR_EMAIL = 'doctor@doc-test.local';
  const PASSWORD = 'CorrectHorseBattery!2026';
  const ALLOWED_HPR = '12345678901234';
  const STUB_OTP = '424242';
  let tenantId = '';
  let doctorId = '';

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
    process.env['HPR_STUB_ALLOWLIST'] = ALLOWED_HPR;
    process.env['HPR_STUB_OTP'] = STUB_OTP;

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const tenant = await tx.tenant.create({
        data: { slug: 'tenant-doc', displayName: 'Doctor Test', lifecycleState: 'IN_SETUP' },
      });
      tenantId = tenant.id;
      const requesterRole = await tx.role.create({
        data: {
          tenantId: tenant.id,
          name: 'insurance_desk_executive',
          permissions: ['preauth.sign_clinical', 'audit.view'],
        },
      });
      const readerRole = await tx.role.create({
        data: { tenantId: tenant.id, name: 'read_only', permissions: ['case.view'] },
      });
      const doctorRole = await tx.role.create({
        data: { tenantId: tenant.id, name: 'doctor', permissions: [] },
      });

      const requester = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: REQUESTER_EMAIL,
          passwordHash,
          firstName: 'Reqs',
          lastName: 'Ter',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tenant.id, userId: requester.id, roleId: requesterRole.id },
      });

      const reader = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: READER_EMAIL,
          passwordHash,
          firstName: 'Read',
          lastName: 'Er',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tenant.id, userId: reader.id, roleId: readerRole.id },
      });

      const doctor = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: DOCTOR_EMAIL,
          passwordHash,
          firstName: 'Doc',
          lastName: 'Tor',
          status: 'active',
        },
      });
      doctorId = doctor.id;
      await tx.userRole.create({
        data: { tenantId: tenant.id, userId: doctor.id, roleId: doctorRole.id },
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

  // The service stores only the hash; tests can't read the raw token off
  // the DB. Same trick as invitation/password tests — patch the row to a
  // hash of a known raw token under platform_admin context.
  async function plantRawTokenForLatest(rawToken: string, opts?: { expiresAt?: Date }): Promise<string> {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    return migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const latest = await tx.doctorToken.findFirst({
        where: { doctorUserId: doctorId },
        orderBy: { createdAt: 'desc' },
      });
      if (!latest) throw new Error('no doctor token to patch');
      await tx.doctorToken.update({
        where: { id: latest.id },
        data: {
          tokenHash,
          ...(opts?.expiresAt ? { expiresAt: opts.expiresAt } : {}),
        },
      });
      return latest.id;
    });
  }

  async function readAuditRows(action: string): Promise<{ resourceId: string | null }[]> {
    return migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      return tx.auditLog.findMany({
        where: { tenantId, action },
        select: { resourceId: true },
        orderBy: { occurredAt: 'asc' },
      });
    });
  }

  it('non-permitted user cannot issue → 403 AUTH_INSUFFICIENT_PERMISSIONS', async () => {
    const cookies = await loginAs(READER_EMAIL);
    const res = await request(app.getHttpServer())
      .post('/preauth/doctor-tokens')
      .set('Cookie', cookies)
      .send({
        doctorUserId: doctorId,
        caseRef: 'CASE-1',
        patientName: 'Patient One',
      });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AUTH_INSUFFICIENT_PERMISSIONS');
  });

  it('permitted user issues a doctor token → 201 + DOCTOR_SIGNATURE_REQUESTED audit', async () => {
    const cookies = await loginAs(REQUESTER_EMAIL);
    const res = await request(app.getHttpServer())
      .post('/preauth/doctor-tokens')
      .set('Cookie', cookies)
      .send({
        doctorUserId: doctorId,
        caseRef: 'CASE-7',
        patientName: 'Anita Sharma',
      });
    expect(res.status).toBe(201);
    expect(res.body.tokenId).toBeDefined();
    const audits = await readAuditRows('DOCTOR_SIGNATURE_REQUESTED');
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('preview returns case context', async () => {
    const raw = 'TEST-DOCTOR-RAW-TOKEN-1234567890ABCDEF';
    await plantRawTokenForLatest(raw);
    const res = await request(app.getHttpServer())
      .get(`/preauth/doctor-tokens/${raw}/preview`);
    expect(res.status).toBe(200);
    expect(res.body.patientName).toBe('Anita Sharma');
    expect(res.body.caseRef).toBe('CASE-7');
    expect(res.body.scope).toBe('preauth_clinical_sign');
    expect(res.body.tenantDisplayName).toBe('Doctor Test');
  });

  it('sign with bogus HPR → 422 AUTH_HPR_VERIFICATION_FAILED', async () => {
    const raw = 'TEST-DOCTOR-RAW-TOKEN-BAD-HPR-12345';
    await plantRawTokenForLatest(raw);
    const res = await request(app.getHttpServer())
      .post(`/preauth/doctor-tokens/${raw}/sign`)
      .send({ hprId: '00000000000000', hprOtp: STUB_OTP });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('AUTH_HPR_VERIFICATION_FAILED');
  });

  it('sign with valid HPR + OTP → 200; DOCTOR_SIGNED audit row; replay rejected', async () => {
    const raw = 'TEST-DOCTOR-RAW-TOKEN-OK-1234567890';
    await plantRawTokenForLatest(raw);
    const res = await request(app.getHttpServer())
      .post(`/preauth/doctor-tokens/${raw}/sign`)
      .send({ hprId: ALLOWED_HPR, hprOtp: STUB_OTP, signatureNote: 'Approved.' });
    expect(res.status).toBe(200);
    expect(res.body.hprId).toBe(ALLOWED_HPR);
    expect(res.body.doctorFullName).toMatch(/^Dr\. HPR-\d{4}$/);

    const audits = await readAuditRows('DOCTOR_SIGNED');
    expect(audits.length).toBeGreaterThanOrEqual(1);

    // Replay the same raw token — single-use.
    const replay = await request(app.getHttpServer())
      .post(`/preauth/doctor-tokens/${raw}/sign`)
      .send({ hprId: ALLOWED_HPR, hprOtp: STUB_OTP });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('AUTH_DOCTOR_TOKEN_INVALID');
  });

  it('expired token → AUTH_DOCTOR_TOKEN_EXPIRED', async () => {
    // Issue a fresh one via the service then artificially age it.
    const cookies = await loginAs(REQUESTER_EMAIL);
    const issueRes = await request(app.getHttpServer())
      .post('/preauth/doctor-tokens')
      .set('Cookie', cookies)
      .send({
        doctorUserId: doctorId,
        caseRef: 'CASE-OLD',
        patientName: 'Expired Patient',
      });
    expect(issueRes.status).toBe(201);
    const raw = 'TEST-DOCTOR-RAW-TOKEN-EXPIRED-1234567890';
    await plantRawTokenForLatest(raw, { expiresAt: new Date(Date.now() - 60_000) });
    const res = await request(app.getHttpServer())
      .post(`/preauth/doctor-tokens/${raw}/sign`)
      .send({ hprId: ALLOWED_HPR, hprOtp: STUB_OTP });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_DOCTOR_TOKEN_EXPIRED');
  });
});
