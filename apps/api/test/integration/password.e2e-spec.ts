// Slice C integration test — password policy + reset + change end to end.
//   1. Reset initiate is silent for unknown email and known email (both 204).
//   2. Reset complete with weak password → 422 AUTH_PASSWORD_TOO_WEAK.
//   3. Reset complete with breached password → 422 AUTH_PASSWORD_BREACHED.
//   4. Reset complete with valid password → 204; user can log in with the new pw.
//   5. Replaying the same reset token → 409 AUTH_PASSWORD_RESET_TOKEN_USED.
//   6. /auth/me/password rejects reuse of the previous password (history).
//   7. /auth/me/password rejects wrong currentPassword.
//   8. /auth/me/password happy-path → 204 and new password works.

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

describe('Slice C — password policy + reset + change', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const USER_EMAIL = 'user-pw@pw-test.local';
  const INITIAL_PASSWORD = 'CorrectHorseBattery!2026';
  let tenantId = '';
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

    const passwordHash = await hash(INITIAL_PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const tenant = await tx.tenant.create({
        data: { slug: 'tenant-pw', displayName: 'Password Test', lifecycleState: 'IN_SETUP' },
      });
      tenantId = tenant.id;
      const role = await tx.role.create({
        data: { tenantId: tenant.id, name: 'tenant_admin', permissions: ['user.invite'] },
      });
      const u = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: USER_EMAIL,
          passwordHash,
          firstName: 'PwUser',
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

  async function loginAs(email: string, password: string): Promise<string[]> {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    expect(res.status).toBe(200);
    const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
    return (Array.isArray(raw) ? raw : raw ? [raw] : [])
      .map((c) => c.split(';')[0])
      .filter((c): c is string => Boolean(c));
  }

  // The PasswordService stores only the hash; tests can't read the raw token
  // out of the DB. Same trick as invitation.e2e — patch the row to a hash of
  // a known raw token under platform_admin context.
  async function plantResetTokenForUser(rawToken: string): Promise<void> {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      // Clean any existing rows so we always run against a fresh token.
      await tx.passwordResetToken.deleteMany({ where: { userId } });
      await tx.passwordResetToken.create({
        data: {
          tenantId,
          userId,
          tokenHash,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      });
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

  it('GET /auth/password-policy returns the descriptor', async () => {
    const res = await request(app.getHttpServer()).get('/auth/password-policy');
    expect(res.status).toBe(200);
    expect(res.body.minLength).toBe(12);
    expect(res.body.historyDepth).toBeGreaterThan(0);
  });

  it('reset initiate is always 204 (unknown email)', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/password-reset/initiate')
      .send({ email: 'no-such-user@nowhere.local' });
    expect(res.status).toBe(204);
  });

  it('reset initiate is 204 for known email and writes a token + audit row', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/password-reset/initiate')
      .send({ email: USER_EMAIL });
    expect(res.status).toBe(204);

    const tokens = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      return tx.passwordResetToken.findMany({ where: { userId } });
    });
    expect(tokens.length).toBeGreaterThanOrEqual(1);

    const audits = await readAuditRows('USER_PASSWORD_RESET_REQUESTED');
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('reset complete rejects weak password → 422 AUTH_PASSWORD_TOO_WEAK', async () => {
    const raw = 'TEST-RESET-RAW-TOKEN-WEAK-1234567890abcdef';
    await plantResetTokenForUser(raw);
    const res = await request(app.getHttpServer())
      .post('/auth/password-reset/complete')
      .send({ token: raw, password: 'alllowercase1234' });
    expect(res.status).toBe(422);
    expect(['AUTH_PASSWORD_TOO_WEAK', 'VALIDATION_FAILED']).toContain(res.body.code);
  });

  it('reset complete rejects breached password → 422 AUTH_PASSWORD_BREACHED', async () => {
    const raw = 'TEST-RESET-RAW-TOKEN-BREACHED-1234567890abc';
    await plantResetTokenForUser(raw);
    // "P@ssword123" is in our common-passwords.txt seed list.
    const res = await request(app.getHttpServer())
      .post('/auth/password-reset/complete')
      .send({ token: raw, password: 'P@ssword123' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('AUTH_PASSWORD_BREACHED');
  });

  it('reset complete with strong password → 204; user can sign in with new pw', async () => {
    const raw = 'TEST-RESET-RAW-TOKEN-OK-1234567890abcdefABC';
    await plantResetTokenForUser(raw);
    const newPassword = 'PurpleZebraSings#9182';
    const res = await request(app.getHttpServer())
      .post('/auth/password-reset/complete')
      .send({ token: raw, password: newPassword });
    expect(res.status).toBe(204);

    const audits = await readAuditRows('USER_PASSWORD_RESET_COMPLETED');
    expect(audits.length).toBeGreaterThanOrEqual(1);

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: USER_EMAIL, password: newPassword });
    expect(login.status).toBe(200);

    // Replay token → used.
    const replay = await request(app.getHttpServer())
      .post('/auth/password-reset/complete')
      .send({ token: raw, password: 'AnotherStrongPass!2027' });
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe('AUTH_PASSWORD_RESET_TOKEN_USED');
  });

  it('change-password rejects wrong currentPassword → 401 AUTH_CURRENT_PASSWORD_INCORRECT', async () => {
    const cookies = await loginAs(USER_EMAIL, 'PurpleZebraSings#9182');
    const res = await request(app.getHttpServer())
      .post('/auth/me/password')
      .set('Cookie', cookies)
      .send({ currentPassword: 'totally-wrong', newPassword: 'BananaThunder!2027ABC' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_CURRENT_PASSWORD_INCORRECT');
  });

  it('change-password rejects reuse of previous password → 422 AUTH_PASSWORD_REUSED', async () => {
    const cookies = await loginAs(USER_EMAIL, 'PurpleZebraSings#9182');
    const res = await request(app.getHttpServer())
      .post('/auth/me/password')
      .set('Cookie', cookies)
      .send({
        currentPassword: 'PurpleZebraSings#9182',
        newPassword: 'PurpleZebraSings#9182',
      });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('AUTH_PASSWORD_REUSED');
  });

  it('change-password happy path → 204 + USER_PASSWORD_CHANGED audit + history written', async () => {
    const cookies = await loginAs(USER_EMAIL, 'PurpleZebraSings#9182');
    const newPassword = 'YellowSubmarineHeads!2028';
    const res = await request(app.getHttpServer())
      .post('/auth/me/password')
      .set('Cookie', cookies)
      .send({
        currentPassword: 'PurpleZebraSings#9182',
        newPassword,
      });
    expect(res.status).toBe(204);

    const audits = await readAuditRows('USER_PASSWORD_CHANGED');
    expect(audits.length).toBeGreaterThanOrEqual(1);

    const history = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      return tx.passwordHistory.findMany({ where: { userId } });
    });
    expect(history.length).toBeGreaterThanOrEqual(1);

    // Old password no longer works; new one does.
    const stale = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: USER_EMAIL, password: 'PurpleZebraSings#9182' });
    expect(stale.status).toBe(401);

    const fresh = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: USER_EMAIL, password: newPassword });
    expect(fresh.status).toBe(200);
  });

  it('change-password rejects reuse of an older password from history', async () => {
    // The previous test's old password ('PurpleZebraSings#9182') is now in
    // history. Trying to rotate back to it should be blocked.
    const cookies = await loginAs(USER_EMAIL, 'YellowSubmarineHeads!2028');
    const res = await request(app.getHttpServer())
      .post('/auth/me/password')
      .set('Cookie', cookies)
      .send({
        currentPassword: 'YellowSubmarineHeads!2028',
        newPassword: 'PurpleZebraSings#9182',
      });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('AUTH_PASSWORD_REUSED');
  });
});
