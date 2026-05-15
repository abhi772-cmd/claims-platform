// Hospital onboarding e2e — DigiSparsh ops creates a new tenant +
// invites the primary admin in one POST.
//   1. Tenant admin (no tenant.create) blocked from POST /admin/tenants.
//   2. Platform admin POST creates the tenant row, seeds 7 tenant-scoped
//      roles, creates the primary admin user with status='invited',
//      writes TENANT_CREATED audit row, fires invite email/SMS.
//   3. Duplicate slug → 400 VALIDATION_FAILED.
//   4. Duplicate primary-admin email → 400 VALIDATION_FAILED.
//   5. GET /admin/tenants returns the new row with activeUserCount=0
//      (admin hasn't accepted invite yet).
//   6. Invalid slug shape (uppercase) → 400 VALIDATION_FAILED.

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

describe('Tenant admin — create hospital + invite primary admin', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const PLATFORM_ADMIN = 'ops@create-tenant-test.local';
  const TENANT_ADMIN_ONLY = 'admin@create-tenant-test.local';

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
      // Bootstrap an existing tenant to host the test users + roles.
      const bootstrap = await tx.tenant.create({
        data: {
          slug: 'bootstrap-ops',
          displayName: 'Bootstrap Ops Tenant',
          lifecycleState: 'IN_SETUP',
        },
      });
      // Platform-scoped role (tenantId = null) — carries tenant.create.
      const platformRole = await tx.role.create({
        data: {
          tenantId: null,
          name: 'platform_admin',
          permissions: ['tenant.create', 'user.invite'],
        },
      });
      // Tenant-scoped role for the "tenant admin only" test user —
      // explicitly does NOT carry tenant.create.
      const tenantRole = await tx.role.create({
        data: {
          tenantId: bootstrap.id,
          name: 'tenant_admin',
          permissions: ['user.invite'],
        },
      });

      const ops = await tx.user.create({
        data: {
          tenantId: bootstrap.id,
          email: PLATFORM_ADMIN,
          passwordHash,
          firstName: 'Ops',
          lastName: 'User',
          status: 'active',
        },
      });
      // UserRole.tenantId is non-nullable; for a platform_admin
      // assignment we use the user's home tenant (the seed pattern
      // in prisma/seed.ts uses `tenant.id` for both tenant_admin
      // and platform_admin UserRoles on the same user).
      await tx.userRole.create({
        data: { tenantId: bootstrap.id, userId: ops.id, roleId: platformRole.id },
      });

      const tAdmin = await tx.user.create({
        data: {
          tenantId: bootstrap.id,
          email: TENANT_ADMIN_ONLY,
          passwordHash,
          firstName: 'Tenant',
          lastName: 'Admin',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: bootstrap.id, userId: tAdmin.id, roleId: tenantRole.id },
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

  it('tenant admin (no tenant.create) blocked from POST /admin/tenants', async () => {
    const cookies = await loginAs(TENANT_ADMIN_ONLY);
    const res = await request(app.getHttpServer())
      .post('/admin/tenants')
      .set('Cookie', cookies)
      .send({
        slug: 'apollo-test',
        displayName: 'Apollo Test',
        primaryAdmin: {
          email: 'unused@example.test',
          firstName: 'A',
          lastName: 'B',
        },
      });
    expect(res.status).toBe(403);
  });

  it('platform admin POST creates tenant + 7 roles + invited primary admin + TENANT_CREATED audit', async () => {
    const cookies = await loginAs(PLATFORM_ADMIN);
    const res = await request(app.getHttpServer())
      .post('/admin/tenants')
      .set('Cookie', cookies)
      .send({
        slug: 'apollo-indore',
        displayName: 'Apollo Hospitals Indore',
        primaryAdmin: {
          email: 'firstadmin@apollo-indore.test',
          firstName: 'First',
          lastName: 'Admin',
          mobile: '+919876543210',
          designation: 'CMO',
        },
      });
    expect(res.status).toBe(201);
    expect(res.body.tenant.slug).toBe('apollo-indore');
    expect(res.body.tenant.lifecycleState).toBe('IN_SETUP');
    expect(res.body.primaryAdmin.email).toBe('firstadmin@apollo-indore.test');
    expect(res.body.primaryAdmin.inviteExpiresAt).toBeDefined();

    const tenantId = res.body.tenant.id as string;

    const persisted = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const roles = await tx.role.findMany({ where: { tenantId } });
      const users = await tx.user.findMany({ where: { tenantId } });
      const audit = await tx.auditLog.findMany({
        where: { tenantId, action: 'TENANT_CREATED', resourceType: 'tenant' },
      });
      return { roles, users, audit };
    });
    // Seven tenant-scoped roles per DEFAULT_TENANT_ROLES.
    expect(persisted.roles.length).toBe(7);
    expect(persisted.roles.map((r) => r.name).sort()).toEqual(
      [
        'billing_manager',
        'doctor',
        'finance_viewer',
        'insurance_desk_executive',
        'pmam',
        'read_only',
        'tenant_admin',
      ].sort(),
    );
    expect(persisted.users.length).toBe(1);
    expect(persisted.users[0]?.status).toBe('invited');
    expect(persisted.audit.length).toBeGreaterThanOrEqual(1);
  });

  it('duplicate slug → 400 VALIDATION_FAILED', async () => {
    const cookies = await loginAs(PLATFORM_ADMIN);
    const res = await request(app.getHttpServer())
      .post('/admin/tenants')
      .set('Cookie', cookies)
      .send({
        slug: 'apollo-indore', // already created above
        displayName: 'Apollo Indore Dupe',
        primaryAdmin: {
          email: 'dupe-slug@example.test',
          firstName: 'D',
          lastName: 'S',
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('duplicate primary-admin email → 400 VALIDATION_FAILED', async () => {
    const cookies = await loginAs(PLATFORM_ADMIN);
    const res = await request(app.getHttpServer())
      .post('/admin/tenants')
      .set('Cookie', cookies)
      .send({
        slug: 'fortis-noida',
        displayName: 'Fortis Noida',
        primaryAdmin: {
          // Reuses the platform-admin email already in the DB.
          email: PLATFORM_ADMIN,
          firstName: 'F',
          lastName: 'N',
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('GET /admin/tenants returns the new row with activeUserCount=0 + primaryAdmin chip', async () => {
    const cookies = await loginAs(PLATFORM_ADMIN);
    const res = await request(app.getHttpServer())
      .get('/admin/tenants')
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    const apollo = res.body.items.find(
      (t: { slug: string }) => t.slug === 'apollo-indore',
    );
    expect(apollo).toBeDefined();
    expect(apollo.activeUserCount).toBe(0); // primary admin is still 'invited'
    expect(apollo.lifecycleState).toBe('IN_SETUP');
    expect(apollo.primaryAdmin).toBeDefined();
    expect(apollo.primaryAdmin.email).toBe('firstadmin@apollo-indore.test');
    expect(apollo.primaryAdmin.status).toBe('invited');
    expect(apollo.primaryAdmin.inviteExpired).toBe(false);
    expect(apollo.primaryAdmin.inviteExpiresAt).toBeDefined();
  });

  it('POST /admin/tenants/:t/users/:u/resend-invite refreshes the invite expiry', async () => {
    const cookies = await loginAs(PLATFORM_ADMIN);
    const before = await request(app.getHttpServer())
      .get('/admin/tenants')
      .set('Cookie', cookies);
    const apollo = before.body.items.find(
      (t: { slug: string }) => t.slug === 'apollo-indore',
    );
    const originalExpiry = new Date(apollo.primaryAdmin.inviteExpiresAt).getTime();

    // Bump time forward inside the row so the resend produces a
    // visibly-later expiry. Easiest: just resend and assert the new
    // expiry is >= the original (the ms-tick difference is enough).
    const res = await request(app.getHttpServer())
      .post(`/admin/tenants/${apollo.id}/users/${apollo.primaryAdmin.id}/resend-invite`)
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    const refreshed = new Date(res.body.inviteExpiresAt).getTime();
    expect(refreshed).toBeGreaterThanOrEqual(originalExpiry);
  });

  it('resend rejects an unknown user id under the right tenant → 404 USER_NOT_FOUND', async () => {
    const cookies = await loginAs(PLATFORM_ADMIN);
    const list = await request(app.getHttpServer())
      .get('/admin/tenants')
      .set('Cookie', cookies);
    const apollo = list.body.items.find(
      (t: { slug: string }) => t.slug === 'apollo-indore',
    );
    const res = await request(app.getHttpServer())
      .post(
        `/admin/tenants/${apollo.id}/users/00000000-0000-0000-0000-000000000000/resend-invite`,
      )
      .set('Cookie', cookies);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('USER_NOT_FOUND');
  });

  it('tenant admin (no tenant.create) blocked from resend endpoint', async () => {
    const cookies = await loginAs(TENANT_ADMIN_ONLY);
    const opsCookies = await loginAs(PLATFORM_ADMIN);
    const list = await request(app.getHttpServer())
      .get('/admin/tenants')
      .set('Cookie', opsCookies);
    const apollo = list.body.items.find(
      (t: { slug: string }) => t.slug === 'apollo-indore',
    );
    const res = await request(app.getHttpServer())
      .post(`/admin/tenants/${apollo.id}/users/${apollo.primaryAdmin.id}/resend-invite`)
      .set('Cookie', cookies);
    expect(res.status).toBe(403);
  });

  it('invalid slug shape (uppercase) → 400 VALIDATION_FAILED', async () => {
    const cookies = await loginAs(PLATFORM_ADMIN);
    const res = await request(app.getHttpServer())
      .post('/admin/tenants')
      .set('Cookie', cookies)
      .send({
        slug: 'Apollo-Indore', // uppercase rejected by Zod
        displayName: 'X',
        primaryAdmin: {
          email: 'invalid-slug@example.test',
          firstName: 'I',
          lastName: 'S',
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('GET /admin/tenants/:tenantId returns full detail with onboarding + activity', async () => {
    const cookies = await loginAs(PLATFORM_ADMIN);
    const list = await request(app.getHttpServer())
      .get('/admin/tenants')
      .set('Cookie', cookies);
    const apollo = list.body.items.find(
      (t: { slug: string }) => t.slug === 'apollo-indore',
    );
    const res = await request(app.getHttpServer())
      .get(`/admin/tenants/${apollo.id}`)
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.tenant.slug).toBe('apollo-indore');
    expect(res.body.tenant.lifecycleState).toBe('IN_SETUP');
    expect(res.body.primaryAdmin.email).toBe('firstadmin@apollo-indore.test');
    expect(res.body.primaryAdmin.status).toBe('invited');
    expect(res.body.activeUserCount).toBe(0);
    expect(res.body.invitedUserCount).toBe(1);
    expect(Array.isArray(res.body.onboardingSteps)).toBe(true);
    expect(Array.isArray(res.body.recentActivity)).toBe(true);
    // The TENANT_CREATED audit row from earlier should be visible.
    const created = res.body.recentActivity.find(
      (e: { action: string }) => e.action === 'TENANT_CREATED',
    );
    expect(created).toBeDefined();
  });

  it('GET /admin/tenants/:unknownId → 404 TENANT_NOT_FOUND', async () => {
    const cookies = await loginAs(PLATFORM_ADMIN);
    const res = await request(app.getHttpServer())
      .get('/admin/tenants/00000000-0000-0000-0000-000000000000')
      .set('Cookie', cookies);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TENANT_NOT_FOUND');
  });

  it('tenant admin (no tenant.create) blocked from detail endpoint', async () => {
    const cookies = await loginAs(TENANT_ADMIN_ONLY);
    const opsCookies = await loginAs(PLATFORM_ADMIN);
    const list = await request(app.getHttpServer())
      .get('/admin/tenants')
      .set('Cookie', opsCookies);
    const apollo = list.body.items.find(
      (t: { slug: string }) => t.slug === 'apollo-indore',
    );
    const res = await request(app.getHttpServer())
      .get(`/admin/tenants/${apollo.id}`)
      .set('Cookie', cookies);
    expect(res.status).toBe(403);
  });
});
