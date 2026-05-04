// Integration test for Slice A:
//   1. /me/permissions reflects the union of role permissions from the JWT.
//   2. A successful login writes a USER_LOGGED_IN audit row.
//   3. A failed login writes a USER_FAILED_LOGIN audit row.
//   4. After 5 failed attempts in 15 min, account locks and a USER_LOCKED row is written.
//   5. Logging out writes USER_LOGGED_OUT.

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

jest.setTimeout(120_000);

describe('Slice A — RBAC and audit pipeline', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const ADMIN_EMAIL = 'admin-rbac@tenant-rbac.local';
  const ADMIN_PASSWORD = 'CorrectHorseBattery!2026';
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

    const passwordHash = await hash(ADMIN_PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const tenant = await tx.tenant.create({
        data: { slug: 'tenant-rbac', displayName: 'RBAC Test', lifecycleState: 'IN_SETUP' },
      });
      tenantId = tenant.id;
      const role = await tx.role.create({
        data: {
          tenantId: tenant.id,
          name: 'tenant_admin',
          permissions: ['user.invite', 'audit.view', 'case.view'],
        },
      });
      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: ADMIN_EMAIL,
          passwordHash,
          firstName: 'Rbac',
          lastName: 'Tester',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tenant.id, userId: user.id, roleId: role.id },
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

  async function login(password: string): Promise<{ cookies: string[]; status: number }> {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: ADMIN_EMAIL, password });
    const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
    const cookies = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((c) => c.split(';')[0]).filter(
      (c): c is string => Boolean(c),
    );
    return { cookies, status: res.status };
  }

  async function readAuditRows(action: string): Promise<{ action: string; resourceId: string | null }[]> {
    const rows = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      return tx.auditLog.findMany({
        where: { tenantId, action },
        select: { action: true, resourceId: true },
        orderBy: { occurredAt: 'asc' },
      });
    });
    return rows;
  }

  it('GET /auth/me/permissions returns role + permission union', async () => {
    const { cookies, status } = await login(ADMIN_PASSWORD);
    expect(status).toBe(200);
    const res = await request(app.getHttpServer())
      .get('/auth/me/permissions')
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual(['tenant_admin']);
    expect(res.body.permissions).toEqual(
      expect.arrayContaining(['user.invite', 'audit.view', 'case.view']),
    );
  });

  it('records USER_LOGGED_IN on success', async () => {
    await login(ADMIN_PASSWORD);
    const rows = await readAuditRows('USER_LOGGED_IN');
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('records USER_FAILED_LOGIN on bad password', async () => {
    const before = (await readAuditRows('USER_FAILED_LOGIN')).length;
    const res = await login('wrong-password');
    expect(res.status).toBe(401);
    const after = (await readAuditRows('USER_FAILED_LOGIN')).length;
    expect(after).toBe(before + 1);
  });

  it('records USER_LOCKED after the 5th failed attempt and refuses further logins', async () => {
    // Already had 1 failure from previous test. Push to lock.
    for (let i = 0; i < 5; i += 1) {
      await login('wrong-password');
    }
    const locked = await readAuditRows('USER_LOCKED');
    expect(locked.length).toBeGreaterThanOrEqual(1);
    // Even with the right password, login is now blocked.
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(res.status).toBe(423);
    expect(res.body.code).toBe('AUTH_ACCOUNT_LOCKED');
  });

  it('records USER_LOGGED_OUT on logout', async () => {
    // Manually unlock for this last leg.
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      await tx.user.updateMany({
        where: { email: ADMIN_EMAIL },
        data: { lockedUntil: null, failedLoginAttempts: 0 },
      });
    });

    const { cookies, status } = await login(ADMIN_PASSWORD);
    expect(status).toBe(200);
    const before = (await readAuditRows('USER_LOGGED_OUT')).length;
    const res = await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Cookie', cookies);
    expect(res.status).toBe(204);
    const after = (await readAuditRows('USER_LOGGED_OUT')).length;
    expect(after).toBe(before + 1);
  });
});
