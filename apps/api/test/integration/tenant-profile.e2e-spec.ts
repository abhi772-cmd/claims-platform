// ON-1 integration test — GET + PATCH /tenant/profile (docs/15 Stage 1).
//   1. Reader without tenant.onboarding.update permission gets 403.
//   2. Admin GET initially returns all-null profile.
//   3. Admin PATCH sets all fields; GET reflects them; audit row written.
//   4. Admin PATCH with sparse update leaves omitted fields untouched.
//   5. Admin PATCH with explicit null clears fields.
//   6. Invalid ROHINI ID (8 digits) → 400 VALIDATION_FAILED.
//   7. Invalid bedCount (zero) → 400 VALIDATION_FAILED.
//   8. Cross-tenant: admin in tenant A can't see tenant B's profile.

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

describe('ON-1 — tenant profile read/write', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN_A = 'admin-a@profile-test.local';
  const READER_A = 'reader-a@profile-test.local';
  const ADMIN_B = 'admin-b@profile-test.local';
  let tenantAId = '';
  let tenantBId = '';

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

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const tenantA = await tx.tenant.create({
        data: { slug: 'tenant-prof-a', displayName: 'Profile Test A', lifecycleState: 'IN_SETUP' },
      });
      tenantAId = tenantA.id;
      const tenantB = await tx.tenant.create({
        data: { slug: 'tenant-prof-b', displayName: 'Profile Test B', lifecycleState: 'IN_SETUP' },
      });
      tenantBId = tenantB.id;

      const adminRoleA = await tx.role.create({
        data: {
          tenantId: tenantA.id,
          name: 'tenant_admin',
          permissions: ['tenant.onboarding.update'],
        },
      });
      const readerRoleA = await tx.role.create({
        data: { tenantId: tenantA.id, name: 'read_only', permissions: ['case.view'] },
      });
      const adminRoleB = await tx.role.create({
        data: {
          tenantId: tenantB.id,
          name: 'tenant_admin',
          permissions: ['tenant.onboarding.update'],
        },
      });

      const aA = await tx.user.create({
        data: {
          tenantId: tenantA.id,
          email: ADMIN_A,
          passwordHash,
          firstName: 'A',
          lastName: 'Admin',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tenantA.id, userId: aA.id, roleId: adminRoleA.id },
      });
      const rA = await tx.user.create({
        data: {
          tenantId: tenantA.id,
          email: READER_A,
          passwordHash,
          firstName: 'A',
          lastName: 'Reader',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tenantA.id, userId: rA.id, roleId: readerRoleA.id },
      });
      const aB = await tx.user.create({
        data: {
          tenantId: tenantB.id,
          email: ADMIN_B,
          passwordHash,
          firstName: 'B',
          lastName: 'Admin',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tenantB.id, userId: aB.id, roleId: adminRoleB.id },
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

  it('reader without tenant.onboarding.update is blocked from GET /tenant/profile', async () => {
    const cookies = await loginAs(READER_A);
    const res = await request(app.getHttpServer())
      .get('/tenant/profile')
      .set('Cookie', cookies);
    expect(res.status).toBe(403);
  });

  it('admin GET initially returns all-null profile', async () => {
    const cookies = await loginAs(ADMIN_A);
    const res = await request(app.getHttpServer())
      .get('/tenant/profile')
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      legalName: null,
      rohiniId: null,
      hospitalType: null,
      bedCount: null,
      hmisVendor: null,
      expectedMonthlyClaimsBand: null,
    });
  });

  it('admin PATCH sets fields; subsequent GET reflects them; TENANT_UPDATED audit written', async () => {
    const cookies = await loginAs(ADMIN_A);
    const patch = {
      legalName: 'Apollo Hospitals Indore',
      rohiniId: '123456789',
      hospitalType: 'private',
      bedCount: 250,
      hmisVendor: 'Birlamedisoft',
      expectedMonthlyClaimsBand: 'band_500_2000',
    };
    const patchRes = await request(app.getHttpServer())
      .patch('/tenant/profile')
      .set('Cookie', cookies)
      .send(patch);
    expect(patchRes.status).toBe(200);
    expect(patchRes.body).toEqual(patch);

    const getRes = await request(app.getHttpServer())
      .get('/tenant/profile')
      .set('Cookie', cookies);
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual(patch);

    const audits = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      return tx.auditLog.findMany({
        where: {
          tenantId: tenantAId,
          action: 'TENANT_UPDATED',
          resourceType: 'tenant_profile',
        },
      });
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const latest = audits[audits.length - 1]!;
    expect(latest.after).toMatchObject({ legalName: 'Apollo Hospitals Indore' });
  });

  it('admin PATCH sparse: omitted keys are untouched', async () => {
    const cookies = await loginAs(ADMIN_A);
    const patchRes = await request(app.getHttpServer())
      .patch('/tenant/profile')
      .set('Cookie', cookies)
      .send({ bedCount: 300 });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.bedCount).toBe(300);
    // legalName from prior test should still be present.
    expect(patchRes.body.legalName).toBe('Apollo Hospitals Indore');
  });

  it('admin PATCH with explicit null clears the column', async () => {
    const cookies = await loginAs(ADMIN_A);
    const patchRes = await request(app.getHttpServer())
      .patch('/tenant/profile')
      .set('Cookie', cookies)
      .send({ hmisVendor: null });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.hmisVendor).toBeNull();
    // Other fields untouched.
    expect(patchRes.body.bedCount).toBe(300);
  });

  it('invalid ROHINI (8 digits) → 400 VALIDATION_FAILED', async () => {
    const cookies = await loginAs(ADMIN_A);
    const res = await request(app.getHttpServer())
      .patch('/tenant/profile')
      .set('Cookie', cookies)
      .send({ rohiniId: '12345678' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('bedCount=0 → 400 VALIDATION_FAILED', async () => {
    const cookies = await loginAs(ADMIN_A);
    const res = await request(app.getHttpServer())
      .patch('/tenant/profile')
      .set('Cookie', cookies)
      .send({ bedCount: 0 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('cross-tenant: tenant B admin does not see tenant A profile', async () => {
    const cookies = await loginAs(ADMIN_B);
    const res = await request(app.getHttpServer())
      .get('/tenant/profile')
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    // Tenant B has had no PATCH — should still be all-null.
    expect(res.body.legalName).toBeNull();
    expect(res.body.bedCount).toBeNull();
    // Sanity — distinct from tenant B's record.
    expect(tenantBId).not.toBe(tenantAId);
  });
});
