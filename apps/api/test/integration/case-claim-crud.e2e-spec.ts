// Slice J integration test — case + claim CRUD over HTTP.
//   1. Permission gate: read-only role can't POST /cases.
//   2. Permitted user creates case → 201; case.created event present;
//      claim row materialised at INITIATED.
//   3. GET /cases lists the new case (tenant-scoped).
//   4. GET /cases/:id returns the detail with embedded claim.
//   5. GET /cases/:caseId/claims/:claimId/events returns the timeline.
//   6. POST /transitions (manual, perm-gated to case.assign) drives the
//      claim through eligibility → preauth.
//   7. PATCH /cases/:id closes the case + sets closedAt.
//   8. Cross-tenant GET /cases returns no rows from the other tenant.

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

describe('Slice J — case + claim CRUD', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN_A = 'admin-case-a@case-test.local';
  const READER_A = 'reader-case-a@case-test.local';
  const ADMIN_B = 'admin-case-b@case-test.local';
  let tenantA = '';
  let tenantB = '';

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

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      // Tenant A: admin (case.create + view + assign), reader (case.view only).
      const a = await tx.tenant.create({
        data: { slug: 'tenant-case-a', displayName: 'Case A', lifecycleState: 'IN_SETUP' },
      });
      tenantA = a.id;
      const adminRoleA = await tx.role.create({
        data: {
          tenantId: a.id,
          name: 'tenant_admin',
          permissions: ['case.create', 'case.view', 'case.assign', 'audit.view'],
        },
      });
      const readerRoleA = await tx.role.create({
        data: { tenantId: a.id, name: 'read_only', permissions: ['case.view'] },
      });
      const adminA = await tx.user.create({
        data: {
          tenantId: a.id, email: ADMIN_A, passwordHash,
          firstName: 'A', lastName: 'Admin', status: 'active',
        },
      });
      await tx.userRole.create({ data: { tenantId: a.id, userId: adminA.id, roleId: adminRoleA.id } });
      const readerA = await tx.user.create({
        data: {
          tenantId: a.id, email: READER_A, passwordHash,
          firstName: 'A', lastName: 'Reader', status: 'active',
        },
      });
      await tx.userRole.create({ data: { tenantId: a.id, userId: readerA.id, roleId: readerRoleA.id } });

      // Tenant B: admin only.
      const b = await tx.tenant.create({
        data: { slug: 'tenant-case-b', displayName: 'Case B', lifecycleState: 'IN_SETUP' },
      });
      tenantB = b.id;
      const adminRoleB = await tx.role.create({
        data: {
          tenantId: b.id, name: 'tenant_admin',
          permissions: ['case.create', 'case.view'],
        },
      });
      const adminB = await tx.user.create({
        data: {
          tenantId: b.id, email: ADMIN_B, passwordHash,
          firstName: 'B', lastName: 'Admin', status: 'active',
        },
      });
      await tx.userRole.create({ data: { tenantId: b.id, userId: adminB.id, roleId: adminRoleB.id } });
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

  it('reader cannot POST /cases → 403 AUTH_INSUFFICIENT_PERMISSIONS', async () => {
    const cookies = await loginAs(READER_A);
    const res = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'Anita Sharma',
        hospitalMrn: 'MRN-001',
        admissionDate: '2026-05-01',
        admissionType: 'planned',
        primaryRail: 'nhcx',
      });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AUTH_INSUFFICIENT_PERMISSIONS');
  });

  let createdCaseId = '';
  let createdClaimId = '';

  it('admin creates case → 201 with first claim at INITIATED', async () => {
    const cookies = await loginAs(ADMIN_A);
    const res = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'Anita Sharma',
        hospitalMrn: 'MRN-001',
        admissionDate: '2026-05-01',
        admissionType: 'planned',
        primaryRail: 'nhcx',
      });
    expect(res.status).toBe(201);
    expect(res.body.patientName).toBe('Anita Sharma');
    expect(res.body.claims).toHaveLength(1);
    expect(res.body.claims[0].status).toBe('INITIATED');
    createdCaseId = res.body.id as string;
    createdClaimId = res.body.claims[0].id as string;
  });

  it('GET /cases lists the new case (tenant-scoped)', async () => {
    const cookies = await loginAs(ADMIN_A);
    const res = await request(app.getHttpServer())
      .get('/cases')
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.cases.length).toBeGreaterThanOrEqual(1);
    expect(res.body.cases.find((c: { id: string }) => c.id === createdCaseId)).toBeDefined();
  });

  it('GET /cases/:id returns detail with embedded claims', async () => {
    const cookies = await loginAs(ADMIN_A);
    const res = await request(app.getHttpServer())
      .get(`/cases/${createdCaseId}`)
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.claims[0].id).toBe(createdClaimId);
  });

  it('GET claim events returns the case.created entry', async () => {
    const cookies = await loginAs(ADMIN_A);
    const res = await request(app.getHttpServer())
      .get(`/cases/${createdCaseId}/claims/${createdClaimId}/events`)
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].eventType).toBe('case.created');
  });

  it('manual transitions drive the claim through eligibility → preauth', async () => {
    const cookies = await loginAs(ADMIN_A);
    const events = ['eligibility.requested', 'eligibility.verified', 'preauth.drafting_started'];
    for (const eventType of events) {
      const res = await request(app.getHttpServer())
        .post(`/cases/${createdCaseId}/claims/${createdClaimId}/transitions`)
        .set('Cookie', cookies)
        .send({ eventType });
      expect(res.status).toBe(200);
    }
    const detail = await request(app.getHttpServer())
      .get(`/cases/${createdCaseId}`)
      .set('Cookie', cookies);
    expect(detail.body.claims[0].status).toBe('PREAUTH_DRAFTING');
  });

  it('reader cannot POST /transitions → 403', async () => {
    const cookies = await loginAs(READER_A);
    const res = await request(app.getHttpServer())
      .post(`/cases/${createdCaseId}/claims/${createdClaimId}/transitions`)
      .set('Cookie', cookies)
      .send({ eventType: 'preauth.submitted_internally' });
    expect(res.status).toBe(403);
  });

  it('PATCH /cases/:id closes case + sets closedAt', async () => {
    const cookies = await loginAs(ADMIN_A);
    const res = await request(app.getHttpServer())
      .patch(`/cases/${createdCaseId}`)
      .set('Cookie', cookies)
      .send({ caseStatus: 'closed' });
    expect(res.status).toBe(200);
    expect(res.body.caseStatus).toBe('closed');
    expect(res.body.closedAt).not.toBeNull();
  });

  it('cross-tenant GET /cases returns nothing from the other tenant', async () => {
    // Create a case under tenant B as admin B.
    const cookiesB = await loginAs(ADMIN_B);
    const resB = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookiesB)
      .send({
        patientName: 'Tenant B Patient',
        hospitalMrn: 'MRN-B-001',
        admissionDate: '2026-05-01',
        admissionType: 'emergency',
        primaryRail: 'pmjay',
      });
      expect(resB.status).toBe(201);
    const tenantBCaseId = resB.body.id as string;

    // Read /cases as admin A — must NOT see tenantB's case.
    const cookiesA = await loginAs(ADMIN_A);
    const list = await request(app.getHttpServer())
      .get('/cases?status=open')
      .set('Cookie', cookiesA);
    expect(list.status).toBe(200);
    expect(
      list.body.cases.find((c: { id: string }) => c.id === tenantBCaseId),
    ).toBeUndefined();

    // GET by id should also fail (404-shaped — VALIDATION_FAILED detail).
    const direct = await request(app.getHttpServer())
      .get(`/cases/${tenantBCaseId}`)
      .set('Cookie', cookiesA);
    expect(direct.status).toBe(422);

    // Sanity: admin B can see it.
    const detail = await request(app.getHttpServer())
      .get(`/cases/${tenantBCaseId}`)
      .set('Cookie', cookiesB);
    expect(detail.status).toBe(200);
    expect(detail.body.id).toBe(tenantBCaseId);
    void tenantA;
    void tenantB;
  });
});
