// Slice BU — compliance dashboard endpoint e2e canary.
//
//   1. GET /admin/compliance/dashboard returns the rollup payload
//      with all expected sections.
//   2. Retention class breakdown includes one row per class with
//      total + pastFloor.
//   3. Open breach with dueAt in the past is flagged overdue=true.
//   4. Recent decrypt event with consentGrantId reflects the
//      bound consent's status; null binding → consentStatus='unbound'
//      and counts toward unboundAccessCountLast24h.
//   5. Reader without audit.view → 403.
//   6. Cross-tenant isolation: tenant A's payload sees tenant A
//      counts only.

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

describe('Slice BU — compliance dashboard', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN_A = 'admin-bu-a@bu-test.local';
  const READER_A = 'reader-bu-a@bu-test.local';
  const ADMIN_B = 'admin-bu-b@bu-test.local';
  let tenantAId: string;
  let tenantBId: string;
  let actorAId: string;

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
      const tA = await tx.tenant.create({
        data: { slug: 'tenant-bu-a', displayName: 'BU A', lifecycleState: 'IN_SETUP' },
      });
      tenantAId = tA.id;
      const tB = await tx.tenant.create({
        data: { slug: 'tenant-bu-b', displayName: 'BU B', lifecycleState: 'IN_SETUP' },
      });
      tenantBId = tB.id;
      const adminRoleA = await tx.role.create({
        data: {
          tenantId: tA.id,
          name: 'tenant_admin',
          permissions: ['audit.view', 'breach_incident.manage'],
        },
      });
      const readerRoleA = await tx.role.create({
        data: { tenantId: tA.id, name: 'reader', permissions: ['case.view'] },
      });
      const adminRoleB = await tx.role.create({
        data: { tenantId: tB.id, name: 'tenant_admin', permissions: ['audit.view'] },
      });
      const ua = await tx.user.create({
        data: {
          tenantId: tA.id, email: ADMIN_A, passwordHash,
          firstName: 'A', lastName: 'Admin', status: 'active',
        },
      });
      actorAId = ua.id;
      await tx.userRole.create({
        data: { tenantId: tA.id, userId: ua.id, roleId: adminRoleA.id },
      });
      const ur = await tx.user.create({
        data: {
          tenantId: tA.id, email: READER_A, passwordHash,
          firstName: 'A', lastName: 'Reader', status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tA.id, userId: ur.id, roleId: readerRoleA.id },
      });
      const ub = await tx.user.create({
        data: {
          tenantId: tB.id, email: ADMIN_B, passwordHash,
          firstName: 'B', lastName: 'Admin', status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tB.id, userId: ub.id, roleId: adminRoleB.id },
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

  it('GET /admin/compliance/dashboard returns the full rollup', async () => {
    const cookies = await loginAs(ADMIN_A);
    const r = await request(app.getHttpServer())
      .get('/admin/compliance/dashboard')
      .set('Cookie', cookies);
    expect(r.status).toBe(200);
    expect(r.body.generatedAt).toBeDefined();
    expect(Array.isArray(r.body.retentionClasses)).toBe(true);
    // All six retention classes should appear, even when total=0.
    expect(r.body.retentionClasses.length).toBe(6);
    for (const c of r.body.retentionClasses) {
      expect(typeof c.total).toBe('number');
      expect(typeof c.pastFloor).toBe('number');
    }
    expect(r.body.breachCounts).toMatchObject({
      detected: expect.any(Number),
      notified: expect.any(Number),
      dismissed: expect.any(Number),
      resolved: expect.any(Number),
    });
    expect(r.body.consentCounts).toMatchObject({
      granted: expect.any(Number),
      withdrawn: expect.any(Number),
    });
  });

  it('open breach with dueAt in the past flags overdue=true', async () => {
    // Plant a breach_incident row with dpdpNotificationDueAt in the
    // past directly on the DB. Service-level path always stamps now+72h
    // so we go through the migrator + platform_admin to seed an
    // overdue row deterministically.
    const breachId = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantAId}, true)`);
      const row = await tx.breachIncident.create({
        data: {
          tenantId: tenantAId,
          kind: 'MANUAL_REPORT',
          severity: 'high',
          status: 'detected',
          dataCategories: ['aadhaar'],
          description: 'Synthetic overdue incident for BU dashboard test.',
          evidenceEventIds: [],
          openedAt: new Date(Date.now() - 96 * 60 * 60 * 1000), // 4d ago
          dpdpNotificationDueAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // 1d ago
          affectedDataPrincipals: 5,
        },
      });
      return row.id;
    });

    const cookies = await loginAs(ADMIN_A);
    const r = await request(app.getHttpServer())
      .get('/admin/compliance/dashboard')
      .set('Cookie', cookies);
    expect(r.status).toBe(200);
    const overdue = r.body.openBreaches.find((b: { id: string }) => b.id === breachId);
    expect(overdue).toBeDefined();
    expect(overdue.overdue).toBe(true);
  });

  it('decrypt event with bound consentGrantId reflects consent status; null binding counts as unbound', async () => {
    // Seed a patient + consent + two decrypt events: one bound, one unbound.
    const cookies = await loginAs(ADMIN_A);

    const patientId = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantAId}, true)`);
      const p = await tx.patient.create({
        data: { tenantId: tenantAId, fullName: 'BU Patient' },
        select: { id: true },
      });
      return p.id;
    });

    // Grant a consent.
    const grant = await request(app.getHttpServer())
      .post('/consents')
      .set('Cookie', cookies)
      .send({
        patientId,
        consentType: 'nhcx_processing',
        dataCategories: ['aadhaar'],
        purposes: ['eligibility.verify'],
        lawfulBasis: 'consent',
        source: 'in_person',
        evidence: {
          noticeText: 'Notice text for BU test.',
          acknowledgedVia: 'in_person_signature',
        },
      });
    // The admin role here doesn't have consent.manage by default.
    // We seeded it without consent.manage to keep the fixture small;
    // grant via direct DB seed instead.
    let consentGrantId: string;
    if (grant.status !== 200) {
      consentGrantId = await migrator.$transaction(async (tx) => {
        await tx.$executeRaw(
          Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
        );
        await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantAId}, true)`);
        const c = await tx.consentRecord.create({
          data: {
            tenantId: tenantAId,
            patientId,
            consentType: 'nhcx_processing',
            dataCategories: ['aadhaar'],
            purposes: ['eligibility.verify'],
            lawfulBasis: 'consent',
            status: 'granted',
            source: 'in_person',
            evidence: {
              noticeText: 'BU test notice',
              acknowledgedVia: 'in_person_signature',
            },
            capturedByUserId: actorAId,
          },
        });
        return c.id;
      });
    } else {
      consentGrantId = grant.body.id;
    }

    // Plant two recent decrypt events.
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantAId}, true)`);
      await tx.dataAccessEvent.create({
        data: {
          tenantId: tenantAId,
          actorUserId: actorAId,
          actorType: 'user',
          resourceType: 'patient',
          resourceId: patientId,
          action: 'decrypt',
          purpose: 'eligibility.verify',
          fieldNames: ['aadhaar'],
          consentGrantId,
        },
      });
      await tx.dataAccessEvent.create({
        data: {
          tenantId: tenantAId,
          actorUserId: actorAId,
          actorType: 'user',
          resourceType: 'patient',
          resourceId: patientId,
          action: 'decrypt',
          purpose: 'preauth.submit',
          fieldNames: ['mobile'],
          consentGrantId: null,
        },
      });
    });

    const r = await request(app.getHttpServer())
      .get('/admin/compliance/dashboard')
      .set('Cookie', cookies);
    expect(r.status).toBe(200);

    const bound = r.body.recentDataAccess.find(
      (e: { consentGrantId: string | null }) => e.consentGrantId === consentGrantId,
    );
    expect(bound).toBeDefined();
    expect(bound.consentStatus).toBe('granted');

    const unbound = r.body.recentDataAccess.find(
      (e: { consentGrantId: string | null; purpose: string }) =>
        e.consentGrantId === null && e.purpose === 'preauth.submit',
    );
    expect(unbound).toBeDefined();
    expect(unbound.consentStatus).toBe('unbound');

    expect(r.body.unboundAccessCountLast24h).toBeGreaterThanOrEqual(1);
  });

  it('reader without audit.view → 403', async () => {
    const cookies = await loginAs(READER_A);
    const r = await request(app.getHttpServer())
      .get('/admin/compliance/dashboard')
      .set('Cookie', cookies);
    expect(r.status).toBe(403);
  });

  it('cross-tenant isolation: tenant B payload omits tenant A activity', async () => {
    // Plant a tenant A breach and verify tenant B's dashboard
    // doesn't see it.
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantAId}, true)`);
      await tx.breachIncident.create({
        data: {
          tenantId: tenantAId,
          kind: 'MANUAL_REPORT',
          severity: 'low',
          status: 'detected',
          dataCategories: ['aadhaar'],
          description: 'Tenant A only — should not appear on tenant B dashboard.',
          evidenceEventIds: [],
          dpdpNotificationDueAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
          affectedDataPrincipals: 1,
        },
      });
    });

    const bCookies = await loginAs(ADMIN_B);
    const r = await request(app.getHttpServer())
      .get('/admin/compliance/dashboard')
      .set('Cookie', bCookies);
    expect(r.status).toBe(200);
    // Tenant B's audit_log is untouched by this suite — every retention
    // class row should report total=0 even though tenant A planted
    // audit/breach rows. RLS scopes the count() queries by app.tenant_id.
    for (const c of r.body.retentionClasses as Array<{ total: number }>) {
      expect(c.total).toBe(0);
    }
    // tenant B's open-breach list is empty — the tenant A planted row
    // is invisible under tenant B's GUC.
    expect(r.body.openBreaches).toHaveLength(0);
    // Reference tenantBId so it's used (FK target on the seeded user).
    expect(tenantBId).toBeDefined();
  });
});
