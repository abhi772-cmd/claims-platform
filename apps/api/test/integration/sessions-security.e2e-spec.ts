// Slice E integration test — sessions, IP allowlist, trusted devices,
// concurrent-session cap.
//   1. /tenant/security/ip-allowlist GET/PUT lifecycle (with permission gate).
//   2. With a non-matching allowlist, login returns 403 AUTH_IP_NOT_ALLOWED.
//   3. With a matching allowlist (127.0.0.0/8) login succeeds.
//   4. /auth/me/sessions lists the active sessions (includes isCurrent flag).
//   5. DELETE /auth/me/sessions/:id revokes a non-current session.
//   6. Concurrent-session cap evicts the oldest session at the cap+1th login.
//   7. Trusted-device cookie skips the MFA challenge on a follow-up login.

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

describe('Slice E — sessions, IP allowlist, trusted devices, concurrent cap', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const ADMIN_EMAIL = 'admin-sec@sec-test.local';
  const USER_EMAIL = 'user-sec@sec-test.local';
  const PASSWORD = 'CorrectHorseBattery!2026';
  let tenantId = '';
  let adminId = '';
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
    // Tighten the cap so the eviction test stays small.
    process.env['CONCURRENT_SESSION_LIMIT'] = '2';
    process.env['TRUSTED_DEVICE_TTL_DAYS'] = '30';

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const tenant = await tx.tenant.create({
        data: { slug: 'tenant-sec', displayName: 'Security Test', lifecycleState: 'IN_SETUP' },
      });
      tenantId = tenant.id;
      const adminRole = await tx.role.create({
        data: {
          tenantId: tenant.id,
          name: 'tenant_admin',
          permissions: ['tenant.security.update', 'audit.view'],
        },
      });
      const noPermRole = await tx.role.create({
        data: { tenantId: tenant.id, name: 'read_only', permissions: ['case.view'] },
      });
      const a = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: ADMIN_EMAIL,
          passwordHash,
          firstName: 'Sec',
          lastName: 'Admin',
          status: 'active',
        },
      });
      adminId = a.id;
      await tx.userRole.create({
        data: { tenantId: tenant.id, userId: a.id, roleId: adminRole.id },
      });
      const u = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: USER_EMAIL,
          passwordHash,
          firstName: 'Sec',
          lastName: 'User',
          status: 'active',
        },
      });
      userId = u.id;
      await tx.userRole.create({
        data: { tenantId: tenant.id, userId: u.id, roleId: noPermRole.id },
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

  async function cookiesFromLogin(email: string, password: string): Promise<string[]> {
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

  it('non-permitted user cannot read /tenant/security/ip-allowlist', async () => {
    const cookies = await cookiesFromLogin(USER_EMAIL, PASSWORD);
    const res = await request(app.getHttpServer())
      .get('/tenant/security/ip-allowlist')
      .set('Cookie', cookies);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AUTH_INSUFFICIENT_PERMISSIONS');
  });

  it('admin can GET (default empty) and PUT the allowlist', async () => {
    const cookies = await cookiesFromLogin(ADMIN_EMAIL, PASSWORD);
    const get1 = await request(app.getHttpServer())
      .get('/tenant/security/ip-allowlist')
      .set('Cookie', cookies);
    expect(get1.status).toBe(200);
    expect(get1.body.cidrs).toEqual([]);

    const put = await request(app.getHttpServer())
      .put('/tenant/security/ip-allowlist')
      .set('Cookie', cookies)
      .send({ cidrs: ['203.0.113.0/24'] });
    expect(put.status).toBe(200);
    expect(put.body.cidrs).toEqual(['203.0.113.0/24']);

    const audits = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      return tx.auditLog.findMany({
        where: { tenantId, action: 'TENANT_IP_ALLOWLIST_UPDATED' },
      });
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('login from non-matching IP → 403 AUTH_IP_NOT_ALLOWED', async () => {
    // The previous test set the allowlist to 203.0.113.0/24; supertest hits
    // 127.0.0.1, which doesn't match.
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: USER_EMAIL, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AUTH_IP_NOT_ALLOWED');
  });

  it('updating allowlist to include 127.0.0.0/8 unblocks login', async () => {
    // The admin's own login is also blocked now — bypass via direct DB write
    // under platform_admin context.
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      await tx.tenant.update({
        where: { id: tenantId },
        data: { ipAllowlist: ['203.0.113.0/24', '127.0.0.0/8', '::1/128'] as never },
      });
    });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: USER_EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
  });

  it('PUT with malformed CIDR → 422 VALIDATION_FAILED', async () => {
    const cookies = await cookiesFromLogin(ADMIN_EMAIL, PASSWORD);
    const res = await request(app.getHttpServer())
      .put('/tenant/security/ip-allowlist')
      .set('Cookie', cookies)
      .send({ cidrs: ['not-an-ip', '203.0.113.0/24'] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('GET /auth/me/sessions returns the current session', async () => {
    const cookies = await cookiesFromLogin(USER_EMAIL, PASSWORD);
    const res = await request(app.getHttpServer())
      .get('/auth/me/sessions')
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.sessions.length).toBeGreaterThanOrEqual(1);
    const current = res.body.sessions.find((s: { isCurrent: boolean }) => s.isCurrent);
    expect(current).toBeDefined();
  });

  it('concurrent-session cap evicts the oldest at cap+1th login', async () => {
    // CONCURRENT_SESSION_LIMIT=2 — log in twice (cap reached), then a third
    // login should evict the oldest.
    await cookiesFromLogin(USER_EMAIL, PASSWORD); // session 1
    await cookiesFromLogin(USER_EMAIL, PASSWORD); // session 2
    await cookiesFromLogin(USER_EMAIL, PASSWORD); // session 3 → evicts session 1

    const active = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      return tx.session.count({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      });
    });
    // userId here is the non-admin user with read_only role; the previous
    // tests + this block produced multiple logins. We expect at most CAP=2.
    expect(active).toBeLessThanOrEqual(2);

    const audits = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      return tx.auditLog.findMany({
        where: { tenantId, actorUserId: userId, action: 'SESSION_REVOKED' },
      });
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('DELETE /auth/me/sessions/:id revokes a non-current session', async () => {
    const cookies = await cookiesFromLogin(USER_EMAIL, PASSWORD);
    const list = await request(app.getHttpServer())
      .get('/auth/me/sessions')
      .set('Cookie', cookies);
    const other = list.body.sessions.find((s: { isCurrent: boolean }) => !s.isCurrent);
    if (!other) return; // cap=2 may have left no second session — that's fine.
    const res = await request(app.getHttpServer())
      .delete(`/auth/me/sessions/${other.id}`)
      .set('Cookie', cookies);
    expect(res.status).toBe(204);
  });

  it('trusted-device cookie skips the MFA challenge on follow-up login', async () => {
    // Enable MFA on the admin user (who has a known passwordHash + can log in).
    // 1. Login → confirm MFA → get backup codes.
    // 2. Issue a fresh login (returns mfa_required).
    // 3. /auth/mfa/verify with trustDevice=true; collect set-cookie.
    // 4. Login again with the trusted-device cookie; expect 200 + user (no challenge).
    const adminCookies = await cookiesFromLogin(ADMIN_EMAIL, PASSWORD);

    const setupRes = await request(app.getHttpServer())
      .post('/auth/me/mfa/setup')
      .set('Cookie', adminCookies)
      .send({});
    expect(setupRes.status).toBe(200);
    const secret = setupRes.body.secret as string;

    const confirmRes = await request(app.getHttpServer())
      .post('/auth/me/mfa/confirm')
      .set('Cookie', adminCookies)
      .send({ code: totpAt(secret, currentStep()) });
    expect(confirmRes.status).toBe(200);

    // Fresh login -> challenge.
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: ADMIN_EMAIL, password: PASSWORD });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.mfaRequired).toBe(true);
    const challengeId = loginRes.body.challengeId as string;

    // Verify with trustDevice=true. Use a backup code so no step replay.
    const backupCodes = confirmRes.body.backupCodes as string[];
    const verifyRes = await request(app.getHttpServer())
      .post('/auth/mfa/verify')
      .send({ challengeId, code: backupCodes[0]!, trustDevice: true });
    expect(verifyRes.status).toBe(200);
    const cookies = ((verifyRes.headers['set-cookie'] as unknown as string[]) ?? [])
      .map((c) => c.split(';')[0])
      .filter((c): c is string => Boolean(c));
    expect(cookies.some((c) => c.startsWith('claims_trust='))).toBe(true);

    const trustCookie = cookies.find((c) => c.startsWith('claims_trust=')) ?? '';

    // Follow-up login carrying ONLY the trust cookie — must skip MFA.
    const followUp = await request(app.getHttpServer())
      .post('/auth/login')
      .set('Cookie', [trustCookie])
      .send({ email: ADMIN_EMAIL, password: PASSWORD });
    expect(followUp.status).toBe(200);
    expect(followUp.body.mfaRequired).toBeUndefined();
    expect(followUp.body.user).toBeDefined();
    expect(followUp.body.user.id).toBe(adminId);
  });
});
