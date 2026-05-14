// Slice G integration test — onboarding wizard + readiness + lifecycle FSM.
//   1. Non-permitted user blocked from /tenant/onboarding/steps.
//   2. Admin lists steps (8 entries, all 'pending' to start).
//   3. Admin completes a step → row stored, audit row written.
//   4. Readiness initially fails (steps incomplete).
//   5. Lifecycle → invalid transition (IN_SETUP → LIVE) → 412.
//   6. Lifecycle → IN_SETUP → PILOT blocked by readiness (412).
//   7. After completing required steps + readiness ok → IN_SETUP → PILOT
//      → 200; lifecycle audit row written.
//   8. PILOT → CHURNED (terminal); subsequent transitions disallowed.

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

describe('Slice G — onboarding wizard + readiness + lifecycle', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const ADMIN_EMAIL = 'admin-onb@onb-test.local';
  const READER_EMAIL = 'reader-onb@onb-test.local';
  const PASSWORD = 'CorrectHorseBattery!2026';
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

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const tenant = await tx.tenant.create({
        data: { slug: 'tenant-onb', displayName: 'Onboarding Test', lifecycleState: 'IN_SETUP' },
      });
      tenantId = tenant.id;
      const adminRole = await tx.role.create({
        data: {
          tenantId: tenant.id,
          name: 'tenant_admin',
          permissions: [
            'tenant.onboarding.update',
            'tenant.lifecycle.transition',
            'audit.view',
          ],
        },
      });
      const readerRole = await tx.role.create({
        data: { tenantId: tenant.id, name: 'read_only', permissions: ['case.view'] },
      });
      const a = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: ADMIN_EMAIL,
          passwordHash,
          firstName: 'Onb',
          lastName: 'Admin',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tenant.id, userId: a.id, roleId: adminRole.id },
      });
      const r = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: READER_EMAIL,
          passwordHash,
          firstName: 'Onb',
          lastName: 'Reader',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tenant.id, userId: r.id, roleId: readerRole.id },
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

  it('non-permitted user blocked from /tenant/onboarding/steps', async () => {
    const cookies = await loginAs(READER_EMAIL);
    const res = await request(app.getHttpServer())
      .get('/tenant/onboarding/steps')
      .set('Cookie', cookies);
    expect(res.status).toBe(403);
  });

  it('admin lists 11 pending steps', async () => {
    const cookies = await loginAs(ADMIN_EMAIL);
    const res = await request(app.getHttpServer())
      .get('/tenant/onboarding/steps')
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.steps).toHaveLength(11);
    expect(res.body.steps.every((s: { status: string }) => s.status === 'pending')).toBe(true);
  });

  it('admin completes a step → stored + TENANT_UPDATED audit', async () => {
    const cookies = await loginAs(ADMIN_EMAIL);
    const res = await request(app.getHttpServer())
      .post('/tenant/onboarding/steps/tenant_profile/complete')
      .set('Cookie', cookies)
      .send({ status: 'completed', evidence: { confirmed: true } });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');

    const audits = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      return tx.auditLog.findMany({
        where: { tenantId, action: 'TENANT_UPDATED', resourceType: 'onboarding_step' },
      });
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('readiness initially fails (most steps still pending)', async () => {
    const cookies = await loginAs(ADMIN_EMAIL);
    const res = await request(app.getHttpServer())
      .get('/tenant/readiness')
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(false);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('IN_SETUP → LIVE invalid (skips PILOT) → 412 TENANT_LIFECYCLE_TRANSITION_INVALID', async () => {
    const cookies = await loginAs(ADMIN_EMAIL);
    const res = await request(app.getHttpServer())
      .post('/tenant/lifecycle/transition')
      .set('Cookie', cookies)
      .send({ target: 'LIVE' });
    expect(res.status).toBe(412);
    // FSM check runs before readiness so the FSM-invalid code wins.
    expect(res.body.code).toBe('TENANT_LIFECYCLE_TRANSITION_INVALID');
  });

  it('IN_SETUP → PILOT blocked by readiness when steps incomplete → 412', async () => {
    const cookies = await loginAs(ADMIN_EMAIL);
    const res = await request(app.getHttpServer())
      .post('/tenant/lifecycle/transition')
      .set('Cookie', cookies)
      .send({ target: 'PILOT' });
    expect(res.status).toBe(412);
    expect(res.body.code).toBe('TENANT_READINESS_CHECK_FAILED');
  });

  it('completing required steps unblocks IN_SETUP → PILOT; lifecycle audit written', async () => {
    const cookies = await loginAs(ADMIN_EMAIL);
    const required = [
      'tenant_profile',
      'roles_assigned',
      'nhcx_cert',
      'payer_master',
      'package_master',
      'notification_test',
      // ON-3 swapped kyc_documents_uploaded out for the verified-by-ops
      // gate. The e2e marks it complete manually via the step-complete
      // endpoint to exercise readiness; the real flow runs through the
      // KycService recompute path covered separately in tenant-kyc-review.e2e-spec.
      'kyc_verified_by_ops',
      'legal_acceptance',
    ];
    for (const key of required) {
      const r = await request(app.getHttpServer())
        .post(`/tenant/onboarding/steps/${key}/complete`)
        .set('Cookie', cookies)
        .send({ status: 'completed', evidence: { ok: true } });
      expect(r.status).toBe(200);
    }
    const ready = await request(app.getHttpServer())
      .get('/tenant/readiness')
      .set('Cookie', cookies);
    expect(ready.body.ready).toBe(true);

    const t = await request(app.getHttpServer())
      .post('/tenant/lifecycle/transition')
      .set('Cookie', cookies)
      .send({ target: 'PILOT', reason: 'Smoke testing complete' });
    expect(t.status).toBe(200);
    expect(t.body.state).toBe('PILOT');

    const audits = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      return tx.auditLog.findMany({
        where: { tenantId, action: 'TENANT_LIFECYCLE_TRANSITION' },
      });
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('PILOT → CHURNED is terminal; further transitions rejected', async () => {
    const cookies = await loginAs(ADMIN_EMAIL);
    const t = await request(app.getHttpServer())
      .post('/tenant/lifecycle/transition')
      .set('Cookie', cookies)
      .send({ target: 'CHURNED' });
    expect(t.status).toBe(200);
    expect(t.body.state).toBe('CHURNED');
    expect(t.body.allowedTargets).toEqual([]);

    const followup = await request(app.getHttpServer())
      .post('/tenant/lifecycle/transition')
      .set('Cookie', cookies)
      .send({ target: 'LIVE' });
    // CHURNED is terminal — but login itself is also blocked because the
    // tenant lifecycle gate in AuthService refuses suspended/churned. We
    // only assert that login still works (tenant_admin has a session) and
    // that the transition is not applied. The actual error code may be
    // TENANT_DISABLED on the next login attempt; we stop short of that
    // here. The pre-existing cookie is already valid for /me + sessions
    // because JWTs don't re-check tenant lifecycle. The transition call
    // however MUST refuse.
    expect(followup.status).toBe(412);
    expect(followup.body.code).toBe('TENANT_LIFECYCLE_TRANSITION_INVALID');
  });
});
