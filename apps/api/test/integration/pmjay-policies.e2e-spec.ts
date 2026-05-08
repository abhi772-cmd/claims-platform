// Slice BJ — PMJAY beneficiary policies lookup endpoint.
//
//   1. PMJAY tenant: ABHA lookup → 200 + policies populated.
//   2. PMJAY tenant: mobile lookup → 200 + policies populated.
//   3. PMJAY tenant: STUB-EMPTY identifier → 200 with empty array.
//   4. Non-PMJAY tenant: lookup → 422 with PMJAY-only message.
//   5. PMJAY tenant: malformed ABHA (with hyphens) → 422 from
//      the Zod superRefine (ABHA must be 14 digits without hyphens).
//   6. PMJAY tenant: malformed mobile (12 digits) → 422 from Zod.

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

describe('Slice BJ — PMJAY policies lookup', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const PMJAY_ADMIN = 'admin-pmjay@bj-test.local';
  const PLAIN_ADMIN = 'admin-plain@bj-test.local';

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
    process.env['NHCX_STUB_VERIFY_DEFAULT'] = 'true';

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const perms = ['case.view', 'preauth.draft', 'audit.view'];
      const pmjayTenant = await tx.tenant.create({
        data: {
          slug: 'tenant-bj-pmjay',
          displayName: 'BJ PMJAY',
          lifecycleState: 'IN_SETUP',
          pmjayMode: 'on',
        },
      });
      const pmjayRole = await tx.role.create({
        data: { tenantId: pmjayTenant.id, name: 'tenant_admin', permissions: perms },
      });
      const pmjayUser = await tx.user.create({
        data: {
          tenantId: pmjayTenant.id,
          email: PMJAY_ADMIN,
          passwordHash,
          firstName: 'PMJAY',
          lastName: 'Admin',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: pmjayTenant.id, userId: pmjayUser.id, roleId: pmjayRole.id },
      });

      const plainTenant = await tx.tenant.create({
        data: {
          slug: 'tenant-bj-plain',
          displayName: 'BJ Plain',
          lifecycleState: 'IN_SETUP',
        },
      });
      const plainRole = await tx.role.create({
        data: { tenantId: plainTenant.id, name: 'tenant_admin', permissions: perms },
      });
      const plainUser = await tx.user.create({
        data: {
          tenantId: plainTenant.id,
          email: PLAIN_ADMIN,
          passwordHash,
          firstName: 'Plain',
          lastName: 'Admin',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: plainTenant.id, userId: plainUser.id, roleId: plainRole.id },
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

  it('PMJAY tenant: ABHA lookup → 200 + one policy with PMJAY fields', async () => {
    const cookies = await loginAs(PMJAY_ADMIN);
    const r = await request(app.getHttpServer())
      .post('/pmjay/policies/lookup')
      .set('Cookie', cookies)
      .send({ identifierType: 'abha', identifier: '12345678901234' });
    expect(r.status).toBe(200);
    expect(r.body.policies).toHaveLength(1);
    expect(r.body.policies[0].payerId).toBe('pmjay@hcx');
    expect(r.body.policies[0].productName).toMatch(/PMJAY/);
    expect(r.body.identifierType).toBe('abha');
    expect(r.body.identifier).toBe('12345678901234');
  });

  it('PMJAY tenant: mobile lookup → 200 + populated', async () => {
    const cookies = await loginAs(PMJAY_ADMIN);
    const r = await request(app.getHttpServer())
      .post('/pmjay/policies/lookup')
      .set('Cookie', cookies)
      .send({ identifierType: 'mobile', identifier: '9876543210' });
    expect(r.status).toBe(200);
    expect(r.body.policies.length).toBeGreaterThanOrEqual(1);
  });

  it('non-PMJAY tenant: rejected at tenant gate → 422', async () => {
    const cookies = await loginAs(PLAIN_ADMIN);
    const r = await request(app.getHttpServer())
      .post('/pmjay/policies/lookup')
      .set('Cookie', cookies)
      .send({ identifierType: 'abha', identifier: '12345678901234' });
    expect(r.status).toBe(422);
    expect(r.body.errors?.tenant?.[0]).toMatch(/PMJAY-only/);
  });

  it('PMJAY tenant: malformed ABHA (with hyphens) → 422 from Zod', async () => {
    const cookies = await loginAs(PMJAY_ADMIN);
    const r = await request(app.getHttpServer())
      .post('/pmjay/policies/lookup')
      .set('Cookie', cookies)
      .send({ identifierType: 'abha', identifier: '91-1234-5678-9999' });
    expect(r.status).toBe(422);
    expect(r.body.errors?.identifier?.[0]).toMatch(/14 digits without hyphens/);
  });

  it('PMJAY tenant: malformed mobile (12 digits) → 422 from Zod', async () => {
    const cookies = await loginAs(PMJAY_ADMIN);
    const r = await request(app.getHttpServer())
      .post('/pmjay/policies/lookup')
      .set('Cookie', cookies)
      .send({ identifierType: 'mobile', identifier: '919876543210' });
    expect(r.status).toBe(422);
    expect(r.body.errors?.identifier?.[0]).toMatch(/10 digits/);
  });
});
