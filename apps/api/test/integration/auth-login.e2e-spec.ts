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

describe('Auth login flow', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const TENANT_SLUG = 'tenant-auth-test';
  const ADMIN_EMAIL = 'admin-login@tenant-auth-test';
  const ADMIN_PASSWORD = 'CorrectHorseBattery!2026';

  beforeAll(async () => {
    pg = await startPostgres();
    migrator = new PrismaClient({ datasources: { db: { url: pg.migratorUrl } } });

    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privatePem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'api';
    process.env['PORT'] = '0';
    process.env['DATABASE_URL'] = pg.appUrl;
    process.env['DATABASE_URL_MIGRATOR'] = pg.migratorUrl;
    process.env['JWT_PRIVATE_KEY_BASE64'] = Buffer.from(privatePem).toString('base64');
    process.env['JWT_PUBLIC_KEY_BASE64'] = Buffer.from(publicPem).toString('base64');
    process.env['JWT_ACCESS_TTL'] = '15m';
    process.env['JWT_REFRESH_TTL'] = '7d';
    process.env['COOKIE_DOMAIN'] = 'localhost';
    process.env['COOKIE_SECURE'] = 'false';
    process.env['COOKIE_SAMESITE'] = 'lax';
    process.env['LOG_LEVEL'] = 'warn';
    process.env['CORS_ORIGIN'] = 'http://localhost:3000';

    // Seed a tenant + role + admin user via the migrator role.
    const passwordHash = await hash(ADMIN_PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const tenant = await tx.tenant.create({
        data: { slug: TENANT_SLUG, displayName: 'Auth Test', lifecycleState: 'IN_SETUP' },
      });
      const role = await tx.role.create({
        data: { tenantId: tenant.id, name: 'tenant_admin', permissions: ['user.invite'] },
      });
      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: ADMIN_EMAIL,
          passwordHash,
          firstName: 'Admin',
          lastName: 'User',
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

  it('rejects bad credentials with AUTH_INVALID_CREDENTIALS', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(res.body.type).toContain('AUTH_INVALID_CREDENTIALS');
  });

  it('rejects malformed body with VALIDATION_FAILED', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'not-an-email', password: '' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('logs in and sets HttpOnly access + refresh cookies', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      email: ADMIN_EMAIL,
      firstName: 'Admin',
      lastName: 'User',
    });
    const cookies = res.headers['set-cookie'] as unknown as string[] | string | undefined;
    const cookieList = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
    const access = cookieList.find((c) => c.startsWith('claims_access='));
    const refresh = cookieList.find((c) => c.startsWith('claims_refresh='));
    expect(access).toBeDefined();
    expect(refresh).toBeDefined();
    expect(access).toMatch(/HttpOnly/);
    expect(refresh).toMatch(/HttpOnly/);
  });

  it('GET /auth/me returns the user when access cookie is present', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const cookieHeader = (login.headers['set-cookie'] as unknown as string[])
      .map((c) => c.split(';')[0])
      .filter((c): c is string => Boolean(c));

    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Cookie', cookieHeader);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      email: ADMIN_EMAIL,
      tenantSlug: TENANT_SLUG,
      roles: expect.arrayContaining(['tenant_admin']),
    });
  });

  it('GET /auth/me without a cookie returns 401', async () => {
    const res = await request(app.getHttpServer()).get('/auth/me');
    expect(res.status).toBe(401);
  });
});
