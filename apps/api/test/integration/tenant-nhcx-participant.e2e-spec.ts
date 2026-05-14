// ON-4 integration test — NHCX participant ops registration.
//   1. Tenant admin without nhcx.participant.manage → 403 on /admin/nhcx-participants.
//   2. Platform admin GET list returns one row per tenant; config null pre-registration.
//   3. POST register → 200, returns participantCode; row persists; outbound + inbound
//      integration_message rows recorded; three NHCX onboarding step rows flip to completed.
//   4. Status endpoint reflects the persisted config.
//   5. Invalid input (http:// callback URL) → 400 VALIDATION_FAILED.

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

describe('ON-4 — NHCX participant registration', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const PLATFORM_ADMIN = 'ops@nhcx-test.local';
  const TENANT_ADMIN = 'admin@nhcx-test.local';
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
      const tenant = await tx.tenant.create({
        data: {
          slug: 'apollo-indore',
          displayName: 'Apollo Indore',
          lifecycleState: 'IN_SETUP',
        },
      });
      tenantId = tenant.id;

      const platformRole = await tx.role.create({
        data: {
          tenantId: null,
          name: 'platform_admin',
          permissions: ['nhcx.participant.manage'],
        },
      });
      const adminRole = await tx.role.create({
        data: {
          tenantId: tenant.id,
          name: 'tenant_admin',
          permissions: ['tenant.onboarding.update'],
        },
      });

      const ops = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: PLATFORM_ADMIN,
          passwordHash,
          firstName: 'Op',
          lastName: 'User',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: null, userId: ops.id, roleId: platformRole.id },
      });

      const admin = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: TENANT_ADMIN,
          passwordHash,
          firstName: 'Te',
          lastName: 'Admin',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tenant.id, userId: admin.id, roleId: adminRole.id },
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

  it('tenant admin (no nhcx.participant.manage) blocked from /admin/nhcx-participants', async () => {
    const cookies = await loginAs(TENANT_ADMIN);
    const res = await request(app.getHttpServer())
      .get('/admin/nhcx-participants')
      .set('Cookie', cookies);
    expect(res.status).toBe(403);
  });

  it('platform admin GET list returns the tenant with config=null pre-registration', async () => {
    const cookies = await loginAs(PLATFORM_ADMIN);
    const res = await request(app.getHttpServer())
      .get('/admin/nhcx-participants')
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    const apollo = res.body.items.find(
      (i: { tenantSlug: string }) => i.tenantSlug === 'apollo-indore',
    );
    expect(apollo).toBeDefined();
    expect(apollo.config).toBeNull();
  });

  it('register persists config + writes integration_message pair + audits + flips 3 onboarding steps', async () => {
    const cookies = await loginAs(PLATFORM_ADMIN);
    const body = {
      hfrFacilityId: 'HFR123456',
      callbackUrl: 'https://callback.example.in/nhcx/on_request',
      sandboxMode: true,
    };
    const res = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/nhcx/register-participant`)
      .set('Cookie', cookies)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.participantCode).toBe('apollo-indore@hcx');
    expect(res.body.role).toBe('provider');

    const audit = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const auditRows = await tx.auditLog.findMany({
        where: {
          tenantId,
          action: 'TENANT_UPDATED',
          resourceType: 'tenant_nhcx_config',
        },
      });
      const messages = await tx.integrationMessage.findMany({
        where: {
          tenantId,
          integration: 'nhcx',
          operation: 'participant/register',
        },
      });
      const steps = await tx.onboardingStep.findMany({
        where: {
          tenantId,
          stepKey: { in: ['hfr_facility', 'nhcx_participant_code', 'nhcx_callback_url'] },
        },
      });
      return { auditRows, messages, steps };
    });

    expect(audit.auditRows.length).toBeGreaterThanOrEqual(1);
    // Outbound + inbound pair.
    expect(audit.messages.filter((m) => m.direction === 'outbound').length).toBe(1);
    expect(audit.messages.filter((m) => m.direction === 'inbound').length).toBe(1);
    expect(
      audit.messages.find((m) => m.direction === 'outbound')?.status,
    ).toBe('succeeded');
    // All three NHCX steps flipped to completed.
    expect(audit.steps.length).toBe(3);
    for (const s of audit.steps) {
      expect(s.status).toBe('completed');
    }
  });

  it('status endpoint reflects the persisted config', async () => {
    const cookies = await loginAs(PLATFORM_ADMIN);
    const res = await request(app.getHttpServer())
      .get(`/admin/tenants/${tenantId}/nhcx/participant-status`)
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.config.participantCode).toBe('apollo-indore@hcx');
    expect(res.body.config.callbackUrl).toBe('https://callback.example.in/nhcx/on_request');
  });

  it('http:// callback URL → 400 VALIDATION_FAILED', async () => {
    const cookies = await loginAs(PLATFORM_ADMIN);
    const res = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/nhcx/register-participant`)
      .set('Cookie', cookies)
      .send({
        hfrFacilityId: 'HFR123456',
        callbackUrl: 'http://insecure.example/',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });
});
