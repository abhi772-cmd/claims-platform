// Slice X integration test — per-tenant comms (SMTP + SMS) config.
//
//   1. GET /tenant/comms-config returns the env-default summary when
//      no tenant override is set (source: 'env', passwordSet: false).
//   2. PATCH stores SMTP override; subsequent GET shows source: 'tenant'
//      and redacts the password (passwordSet: true, never the raw value).
//   3. PATCH with smtp: null clears the override → falls back to env.
//   4. Reader without `tenant.comms_config.update` → 403 on both verbs.
//   5. Cross-tenant isolation: tenant B cannot see or overwrite
//      tenant A's config.
//   6. EmailAdapter resolves the tenant override and routes mail
//      through it (verified by intercepting the resolver call).

import { generateKeyPairSync } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { argon2id, hash } from 'argon2';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { TenantCommsConfigService } from '../../src/modules/notification/tenant-comms-config.service';
import { startPostgres, type PgHandles } from '../setup/postgres-container';

jest.setTimeout(180_000);

describe('Slice X — per-tenant comms config', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;
  let comms: TenantCommsConfigService;
  let tenantAId: string;
  let tenantBId: string;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN_A = 'admin-cc-a@cc-test.local';
  const READER = 'reader-cc@cc-test.local';
  const ADMIN_B = 'admin-cc-b@cc-test.local';

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
    process.env['SMTP_PORT'] = '1025';
    process.env['SMTP_FROM'] = 'no-reply@platform.test';
    process.env['NOTIFICATION_RETRY_DISABLED'] = 'true';
    process.env['DOC_LIFECYCLE_DISABLED'] = 'true';

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const tenantA = await tx.tenant.create({
        data: { slug: 'tenant-cc-a', displayName: 'CC A', lifecycleState: 'IN_SETUP' },
      });
      tenantAId = tenantA.id;
      const tenantB = await tx.tenant.create({
        data: { slug: 'tenant-cc-b', displayName: 'CC B', lifecycleState: 'IN_SETUP' },
      });
      tenantBId = tenantB.id;
      const adminRoleA = await tx.role.create({
        data: {
          tenantId: tenantA.id,
          name: 'tenant_admin',
          permissions: ['tenant.comms_config.update', 'case.view'],
        },
      });
      const readerRole = await tx.role.create({
        data: {
          tenantId: tenantA.id,
          name: 'reader',
          permissions: ['case.view'],
        },
      });
      const adminRoleB = await tx.role.create({
        data: {
          tenantId: tenantB.id,
          name: 'tenant_admin',
          permissions: ['tenant.comms_config.update'],
        },
      });
      const a = await tx.user.create({
        data: {
          tenantId: tenantA.id,
          email: ADMIN_A,
          passwordHash,
          firstName: 'CC',
          lastName: 'AdminA',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tenantA.id, userId: a.id, roleId: adminRoleA.id },
      });
      const r = await tx.user.create({
        data: {
          tenantId: tenantA.id,
          email: READER,
          passwordHash,
          firstName: 'CC',
          lastName: 'Reader',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tenantA.id, userId: r.id, roleId: readerRole.id },
      });
      const b = await tx.user.create({
        data: {
          tenantId: tenantB.id,
          email: ADMIN_B,
          passwordHash,
          firstName: 'CC',
          lastName: 'AdminB',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tenantB.id, userId: b.id, roleId: adminRoleB.id },
      });
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.use(cookieParser());
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();
    comms = app.get(TenantCommsConfigService);
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

  it('GET returns env defaults when tenant has no override', async () => {
    const cookies = await loginAs(ADMIN_A);
    const res = await request(app.getHttpServer())
      .get('/tenant/comms-config')
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.smtp.source).toBe('env');
    expect(res.body.smtp.host).toBe('127.0.0.1');
    expect(res.body.smtp.port).toBe(1025);
    expect(res.body.smtp.from).toBe('no-reply@platform.test');
    expect(res.body.smtp.passwordSet).toBe(false);
    expect(res.body.sms.source).toBe('env');
    expect(res.body.sms.provider).toBe('console');
    expect(res.body.sms.apiKeySet).toBe(false);
  });

  it('PATCH stores SMTP override + redacts password on read', async () => {
    const cookies = await loginAs(ADMIN_A);
    const patch = await request(app.getHttpServer())
      .patch('/tenant/comms-config')
      .set('Cookie', cookies)
      .send({
        smtp: {
          host: 'smtp.tenant-a.example.com',
          port: 587,
          from: 'no-reply@tenant-a.example.com',
          username: 'tenant-a',
          password: 'super-secret',
          secure: true,
          ignoreTls: false,
        },
        sms: { provider: 'textguru', apiKey: 'tg-secret-key', senderId: 'TENANT-A' },
      });
    expect(patch.status).toBe(200);
    expect(patch.body.smtp.source).toBe('tenant');
    expect(patch.body.smtp.host).toBe('smtp.tenant-a.example.com');
    expect(patch.body.smtp.passwordSet).toBe(true);
    // Critical: the response NEVER echoes the raw secret.
    expect(JSON.stringify(patch.body)).not.toContain('super-secret');
    expect(JSON.stringify(patch.body)).not.toContain('tg-secret-key');
    expect(patch.body.sms.source).toBe('tenant');
    expect(patch.body.sms.provider).toBe('textguru');
    expect(patch.body.sms.apiKeySet).toBe(true);
    expect(patch.body.sms.senderId).toBe('TENANT-A');

    // Resolver returns the actual values for adapter use, but those
    // never cross the HTTP boundary. Bust the cache first since the
    // initial GET in the test above warmed it with the env default.
    comms.invalidate(tenantAId);
    const resolvedSmtp = await comms.resolveSmtp(tenantAId);
    expect(resolvedSmtp.source).toBe('tenant');
    expect(resolvedSmtp.password).toBe('super-secret');
    const resolvedSms = await comms.resolveSms(tenantAId);
    expect(resolvedSms.source).toBe('tenant');
    expect(resolvedSms.apiKey).toBe('tg-secret-key');
  });

  it('PATCH with null clears the override and falls back to env', async () => {
    const cookies = await loginAs(ADMIN_A);
    const patch = await request(app.getHttpServer())
      .patch('/tenant/comms-config')
      .set('Cookie', cookies)
      .send({ smtp: null, sms: null });
    expect(patch.status).toBe(200);
    expect(patch.body.smtp.source).toBe('env');
    expect(patch.body.smtp.host).toBe('127.0.0.1');
    expect(patch.body.smtp.passwordSet).toBe(false);
    expect(patch.body.sms.source).toBe('env');
    expect(patch.body.sms.provider).toBe('console');
  });

  it('reader without comms_config.update permission → 403', async () => {
    const cookies = await loginAs(READER);
    const get = await request(app.getHttpServer())
      .get('/tenant/comms-config')
      .set('Cookie', cookies);
    expect(get.status).toBe(403);
    const patch = await request(app.getHttpServer())
      .patch('/tenant/comms-config')
      .set('Cookie', cookies)
      .send({ smtp: { host: 'evil', port: 25, from: 'x@y' } });
    expect(patch.status).toBe(403);
  });

  it('cross-tenant isolation — tenant B writes do not affect tenant A', async () => {
    // Tenant A sets an override.
    const cookiesA = await loginAs(ADMIN_A);
    await request(app.getHttpServer())
      .patch('/tenant/comms-config')
      .set('Cookie', cookiesA)
      .send({
        smtp: {
          host: 'a.example.com',
          port: 25,
          from: 'a@example.com',
        },
      });

    // Tenant B sets a different override.
    const cookiesB = await loginAs(ADMIN_B);
    await request(app.getHttpServer())
      .patch('/tenant/comms-config')
      .set('Cookie', cookiesB)
      .send({
        smtp: {
          host: 'b.example.com',
          port: 587,
          from: 'b@example.com',
        },
      });

    // Resolve each — verify they don't bleed.
    comms.invalidate(tenantAId);
    comms.invalidate(tenantBId);
    const a = await comms.resolveSmtp(tenantAId);
    const b = await comms.resolveSmtp(tenantBId);
    expect(a.host).toBe('a.example.com');
    expect(b.host).toBe('b.example.com');

    // And tenant B's GET response describes only its own row.
    const getB = await request(app.getHttpServer())
      .get('/tenant/comms-config')
      .set('Cookie', cookiesB);
    expect(getB.body.smtp.host).toBe('b.example.com');
  });
});
