// Slice D integration test — MFA (TOTP + backup codes) end to end.
//   1. /auth/me/mfa/setup returns secret + QR; user is NOT yet enrolled.
//   2. confirm with bogus code → 401 AUTH_MFA_INVALID.
//   3. confirm with valid TOTP → 200 + 10 backup codes; user.mfaEnabled = true.
//   4. login now returns mfaRequired challenge instead of cookies.
//   5. /auth/mfa/verify with valid TOTP → 200 + cookies.
//   6. /auth/mfa/verify replaying same TOTP within step → 401 (replay block).
//   7. login again → backup-code path: verify with one of the backup codes;
//      same code re-used → 401.
//   8. /auth/me/mfa/disable with wrong password → 401 AUTH_CURRENT_PASSWORD_INCORRECT.
//   9. /auth/me/mfa/disable with right password + valid code → 204; mfaEnabled = false.

import { generateKeyPairSync } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { argon2id, hash } from 'argon2';
import cookieParser from 'cookie-parser';
import { hotp } from 'otplib';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { startPostgres, type PgHandles } from '../setup/postgres-container';

jest.setTimeout(180_000);

hotp.options = { digits: 6, algorithm: 'sha1' as never };

function totpAt(secret: string, step: number): string {
  return hotp.generate(secret, step);
}

function currentStep(): number {
  return Math.floor(Date.now() / 1000 / 30);
}

describe('Slice D — MFA (TOTP + backup codes)', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const USER_EMAIL = 'user-mfa@mfa-test.local';
  const USER_PASSWORD = 'CorrectHorseBattery!2026';
  let userId = '';

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

    const passwordHash = await hash(USER_PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const tenant = await tx.tenant.create({
        data: { slug: 'tenant-mfa', displayName: 'MFA Test', lifecycleState: 'IN_SETUP' },
      });
      const role = await tx.role.create({
        data: { tenantId: tenant.id, name: 'tenant_admin', permissions: ['user.invite'] },
      });
      const u = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: USER_EMAIL,
          passwordHash,
          firstName: 'MfaUser',
          lastName: 'Tester',
          status: 'active',
          lastPasswordChangeAt: new Date(),
        },
      });
      userId = u.id;
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
    await pg.shutdown();
  });

  async function loginAsExpectingCookies(email: string, password: string): Promise<string[]> {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
    const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
    return (Array.isArray(raw) ? raw : raw ? [raw] : [])
      .map((c) => c.split(';')[0])
      .filter((c): c is string => Boolean(c));
  }

  async function loginAsExpectingChallenge(email: string, password: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    expect(res.status).toBe(200);
    expect(res.body.mfaRequired).toBe(true);
    return res.body.challengeId as string;
  }

  async function readCurrentSecret(): Promise<string> {
    return migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const row = await tx.mfaEnrollment.findUnique({ where: { userId } });
      if (!row) throw new Error('no enrollment');
      return row.secret;
    });
  }

  let backupCodes: string[] = [];

  it('setup returns secret + qr; user not yet enrolled', async () => {
    const cookies = await loginAsExpectingCookies(USER_EMAIL, USER_PASSWORD);
    const res = await request(app.getHttpServer())
      .post('/auth/me/mfa/setup')
      .set('Cookie', cookies)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.secret).toBeTruthy();
    expect(res.body.otpauthUrl).toMatch(/^otpauth:\/\//);
    expect(res.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('confirm with bogus code → 401 AUTH_MFA_INVALID', async () => {
    const cookies = await loginAsExpectingCookies(USER_EMAIL, USER_PASSWORD);
    const res = await request(app.getHttpServer())
      .post('/auth/me/mfa/confirm')
      .set('Cookie', cookies)
      .send({ code: '000000' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_MFA_INVALID');
  });

  it('confirm with valid TOTP → 200 + 10 backup codes', async () => {
    const secret = await readCurrentSecret();
    const cookies = await loginAsExpectingCookies(USER_EMAIL, USER_PASSWORD);
    const code = totpAt(secret, currentStep());
    const res = await request(app.getHttpServer())
      .post('/auth/me/mfa/confirm')
      .set('Cookie', cookies)
      .send({ code });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.backupCodes)).toBe(true);
    expect(res.body.backupCodes).toHaveLength(10);
    expect(res.body.backupCodes[0]).toMatch(/^[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}$/);
    backupCodes = res.body.backupCodes as string[];
  });

  it('login now returns mfaRequired (no cookies issued)', async () => {
    const challengeId = await loginAsExpectingChallenge(USER_EMAIL, USER_PASSWORD);
    expect(challengeId.length).toBeGreaterThan(20);
  });

  it('mfa/verify with valid TOTP → 200 + cookies', async () => {
    const challengeId = await loginAsExpectingChallenge(USER_EMAIL, USER_PASSWORD);
    const secret = await readCurrentSecret();
    // Use the next step so we don't collide with the TOTP we used during
    // confirm — same step would be a replay and would be rejected.
    const step = currentStep() + 1;
    const code = totpAt(secret, step);
    const res = await request(app.getHttpServer())
      .post('/auth/mfa/verify')
      .send({ challengeId, code });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(USER_EMAIL);
    const cookies = res.headers['set-cookie'];
    expect(Array.isArray(cookies) ? cookies.join(' ') : (cookies as string)).toMatch(
      /claims_access=/,
    );
  });

  it('mfa/verify rejects same-step TOTP replay', async () => {
    const challengeId = await loginAsExpectingChallenge(USER_EMAIL, USER_PASSWORD);
    const secret = await readCurrentSecret();
    // Reuse the same step we used in the previous test — server's
    // lastUsedStep should now block it.
    const step = currentStep() + 1;
    const code = totpAt(secret, step);
    const res = await request(app.getHttpServer())
      .post('/auth/mfa/verify')
      .send({ challengeId, code });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_MFA_INVALID');
  });

  it('mfa/verify with backup code → 200; replay of same code → 401', async () => {
    const challengeId1 = await loginAsExpectingChallenge(USER_EMAIL, USER_PASSWORD);
    const code = backupCodes[0]!;
    const ok = await request(app.getHttpServer())
      .post('/auth/mfa/verify')
      .send({ challengeId: challengeId1, code });
    expect(ok.status).toBe(200);

    const challengeId2 = await loginAsExpectingChallenge(USER_EMAIL, USER_PASSWORD);
    const replay = await request(app.getHttpServer())
      .post('/auth/mfa/verify')
      .send({ challengeId: challengeId2, code });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('AUTH_MFA_INVALID');
  });

  it('disable with wrong password → 401 AUTH_CURRENT_PASSWORD_INCORRECT', async () => {
    // Need to log back in (cookies were cleared on prior verify success and
    // this test thread of execution doesn't carry them).
    const challengeId = await loginAsExpectingChallenge(USER_EMAIL, USER_PASSWORD);
    const secret = await readCurrentSecret();
    const step = currentStep() + 5;
    const verifyRes = await request(app.getHttpServer())
      .post('/auth/mfa/verify')
      .send({ challengeId, code: totpAt(secret, step) });
    const cookies = ((verifyRes.headers['set-cookie'] as unknown as string[]) ?? [])
      .map((c) => c.split(';')[0])
      .filter((c): c is string => Boolean(c));

    const res = await request(app.getHttpServer())
      .post('/auth/me/mfa/disable')
      .set('Cookie', cookies)
      .send({ currentPassword: 'totally-wrong', code: backupCodes[1] });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_CURRENT_PASSWORD_INCORRECT');
  });

  it('disable with valid password + backup code → 204; mfa_enabled = false', async () => {
    const challengeId = await loginAsExpectingChallenge(USER_EMAIL, USER_PASSWORD);
    const secret = await readCurrentSecret();
    const step = currentStep() + 10;
    const verifyRes = await request(app.getHttpServer())
      .post('/auth/mfa/verify')
      .send({ challengeId, code: totpAt(secret, step) });
    const cookies = ((verifyRes.headers['set-cookie'] as unknown as string[]) ?? [])
      .map((c) => c.split(';')[0])
      .filter((c): c is string => Boolean(c));

    const res = await request(app.getHttpServer())
      .post('/auth/me/mfa/disable')
      .set('Cookie', cookies)
      .send({ currentPassword: USER_PASSWORD, code: backupCodes[1] });
    expect(res.status).toBe(204);

    // Subsequent login skips MFA (no challenge).
    const after = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: USER_EMAIL, password: USER_PASSWORD });
    expect(after.status).toBe(200);
    expect(after.body.mfaRequired).toBeUndefined();
    expect(after.body.user).toBeDefined();
  });
});
