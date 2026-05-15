// T2-15 integration test — IRDAI SLA timers surfaced on case detail.
//
// Drives one case through preauth submit + approval and asserts that
// the SLA payload on GET /cases/:id flips through every status as
// the timeline grows. Uses /transitions to plant events directly
// because the contract under test is the SLA derivation, not the
// upstream preauth flow.

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

describe('T2-15 — IRDAI SLA timers', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN = 'admin-sla@sla-test.local';
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
    process.env['LOG_LEVEL'] = 'warn';
    process.env['CORS_ORIGIN'] = 'http://localhost:3000';
    process.env['WEB_BASE_URL'] = 'http://localhost:3000';
    process.env['SMTP_HOST'] = '127.0.0.1';
    process.env['SMTP_PORT'] = '1';
    process.env['SMTP_FROM'] = 'no-reply@test';
    process.env['NHCX_STUB_VERIFY_DEFAULT'] = 'true';
    process.env['NOTIFICATION_RETRY_DISABLED'] = 'true';
    process.env['DOC_LIFECYCLE_DISABLED'] = 'true';

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const tenant = await tx.tenant.create({
        data: { slug: 'tenant-sla', displayName: 'SLA Tenant', lifecycleState: 'IN_SETUP' },
      });
      tenantId = tenant.id;
      const role = await tx.role.create({
        data: {
          tenantId: tenant.id,
          name: 'tenant_admin',
          permissions: [
            'case.create',
            'case.view',
            'case.assign',
            'preauth.draft',
            'preauth.submit',
          ],
        },
      });
      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: ADMIN,
          passwordHash,
          firstName: 'SLA',
          lastName: 'Admin',
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

  async function plantEventAt(
    claimId: string,
    eventType: string,
    occurredAt: Date,
    resultingStatus: string,
  ): Promise<void> {
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
      );
      const claim = await tx.claim.findUniqueOrThrow({ where: { id: claimId } });
      await tx.claimEvent.create({
        data: {
          tenantId,
          claimId,
          eventType,
          resultingStatus,
          occurredAt,
          recordedById: null,
          payload: {},
        },
      });
      await tx.claim.update({
        where: { id: claimId },
        data: { status: resultingStatus },
      });
      void claim;
    });
  }

  async function createCase(cookies: string[], mrn: string): Promise<string> {
    const create = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'SLA Patient',
        hospitalMrn: mrn,
        admissionDate: '2026-05-01',
        admissionType: 'planned',
        primaryRail: 'nhcx',
      });
    expect(create.status).toBe(201);
    return create.body.id as string;
  }

  it('returns sla.preauth = null when claim has no submitted_internally event', async () => {
    const cookies = await loginAs(ADMIN);
    const caseId = await createCase(cookies, 'MRN-SLA-NULL');
    const res = await request(app.getHttpServer())
      .get(`/cases/${caseId}`)
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.claims[0].sla).toBeDefined();
    expect(res.body.claims[0].sla.preauth).toBeNull();
    expect(res.body.claims[0].sla.claim).toBeNull();
  });

  it('breached preauth: submit 2h ago, no decision', async () => {
    const cookies = await loginAs(ADMIN);
    const caseId = await createCase(cookies, 'MRN-SLA-BREACH');
    const detail = await request(app.getHttpServer())
      .get(`/cases/${caseId}`)
      .set('Cookie', cookies);
    const claimId = detail.body.claims[0].id as string;

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
    await plantEventAt(claimId, 'preauth.submitted_internally', twoHoursAgo, 'PREAUTH_SUBMITTED');

    const res = await request(app.getHttpServer())
      .get(`/cases/${caseId}`)
      .set('Cookie', cookies);
    const sla = res.body.claims[0].sla;
    expect(sla.preauth.status).toBe('breached');
    expect(sla.preauth.windowMinutes).toBe(60);
    expect(sla.preauth.decidedAt).toBeNull();
    expect(sla.preauth.msUntilDeadline).toBeLessThan(0);
  });

  it('met preauth: submit then approve within the 1-hour window', async () => {
    const cookies = await loginAs(ADMIN);
    const caseId = await createCase(cookies, 'MRN-SLA-MET');
    const detail = await request(app.getHttpServer())
      .get(`/cases/${caseId}`)
      .set('Cookie', cookies);
    const claimId = detail.body.claims[0].id as string;

    const submittedAt = new Date(Date.now() - 30 * 60_000);
    const approvedAt = new Date(Date.now() - 10 * 60_000);
    await plantEventAt(
      claimId,
      'preauth.submitted_internally',
      submittedAt,
      'PREAUTH_SUBMITTED',
    );
    await plantEventAt(claimId, 'preauth.approved', approvedAt, 'PREAUTH_APPROVED');

    const res = await request(app.getHttpServer())
      .get(`/cases/${caseId}`)
      .set('Cookie', cookies);
    const sla = res.body.claims[0].sla;
    expect(sla.preauth.status).toBe('met');
    expect(sla.preauth.decidedAt).toBe(approvedAt.toISOString());
    expect(sla.preauth.msUntilDeadline).toBeNull();
  });

  it('on_track preauth: submitted 10m ago, no decision', async () => {
    const cookies = await loginAs(ADMIN);
    const caseId = await createCase(cookies, 'MRN-SLA-OT');
    const detail = await request(app.getHttpServer())
      .get(`/cases/${caseId}`)
      .set('Cookie', cookies);
    const claimId = detail.body.claims[0].id as string;

    const submittedAt = new Date(Date.now() - 10 * 60_000);
    await plantEventAt(claimId, 'preauth.submitted_internally', submittedAt, 'PREAUTH_SUBMITTED');

    const res = await request(app.getHttpServer())
      .get(`/cases/${caseId}`)
      .set('Cookie', cookies);
    const sla = res.body.claims[0].sla;
    expect(sla.preauth.status).toBe('on_track');
    expect(sla.preauth.msUntilDeadline).toBeGreaterThan(0);
  });

  it('claim phase uses the 3-hour window independently of preauth', async () => {
    const cookies = await loginAs(ADMIN);
    const caseId = await createCase(cookies, 'MRN-SLA-CLAIM');
    const detail = await request(app.getHttpServer())
      .get(`/cases/${caseId}`)
      .set('Cookie', cookies);
    const claimId = detail.body.claims[0].id as string;

    const claimSubmitted = new Date(Date.now() - 60 * 60_000); // 1h ago, well under 3h
    await plantEventAt(
      claimId,
      'claim.submitted_internally',
      claimSubmitted,
      'CLAIM_SUBMITTED',
    );

    const res = await request(app.getHttpServer())
      .get(`/cases/${caseId}`)
      .set('Cookie', cookies);
    const sla = res.body.claims[0].sla;
    expect(sla.claim.status).toBe('on_track');
    expect(sla.claim.windowMinutes).toBe(180);
    expect(sla.preauth).toBeNull();
  });
});
