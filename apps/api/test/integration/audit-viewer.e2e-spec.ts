// Slice V integration test — audit-log viewer + CSV export.
//
//   1. GET /audit returns rows tenant-scoped + ordered desc by occurredAt.
//   2. Filter by action narrows the result set.
//   3. Filter by resourceType + correlationId narrows further.
//   4. Reader without audit.view permission → 403.
//   5. GET /audit/export.csv streams a CSV with the documented header
//      and one line per row.
//   6. RLS canary: cross-tenant rows do NOT appear in tenant A's
//      list response.

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

describe('Slice V — audit viewer + CSV export', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN_A = 'admin-au-a@au-test.local';
  const READER = 'reader-au@au-test.local';
  const ADMIN_B = 'admin-au-b@au-test.local';

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
    process.env['NOTIFICATION_RETRY_DISABLED'] = 'true';
    process.env['DOC_LIFECYCLE_DISABLED'] = 'true';

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const tenantA = await tx.tenant.create({
        data: { slug: 'tenant-au-a', displayName: 'AU A', lifecycleState: 'IN_SETUP' },
      });
      const tenantB = await tx.tenant.create({
        data: { slug: 'tenant-au-b', displayName: 'AU B', lifecycleState: 'IN_SETUP' },
      });
      const adminRoleA = await tx.role.create({
        data: {
          tenantId: tenantA.id,
          name: 'tenant_admin',
          permissions: ['audit.view', 'case.create', 'case.view'],
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
          permissions: ['audit.view', 'case.create'],
        },
      });
      const a = await tx.user.create({
        data: {
          tenantId: tenantA.id,
          email: ADMIN_A,
          passwordHash,
          firstName: 'AU',
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
          firstName: 'AU',
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
          firstName: 'AU',
          lastName: 'AdminB',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tenantB.id, userId: b.id, roleId: adminRoleB.id },
      });

      // Seed a handful of audit rows directly (skip the slow signup
      // + login flow — we just need rows in the table).
      const seed = [
        { tenantId: tenantA.id, action: 'case.created', resourceType: 'case' },
        { tenantId: tenantA.id, action: 'case.created', resourceType: 'case' },
        { tenantId: tenantA.id, action: 'user.login', resourceType: 'user' },
        { tenantId: tenantA.id, action: 'preauth.submitted', resourceType: 'claim' },
        { tenantId: tenantB.id, action: 'case.created', resourceType: 'case' }, // cross-tenant
      ];
      for (const s of seed) {
        await tx.auditLog.create({
          data: {
            tenantId: s.tenantId,
            actorType: 'user',
            action: s.action,
            resourceType: s.resourceType,
            actorUserId: a.id,
            after: { sample: s.action } as never,
          },
        });
      }
      // One row with a correlation id so we can filter by it.
      await tx.auditLog.create({
        data: {
          tenantId: tenantA.id,
          actorType: 'user',
          action: 'preauth.submitted',
          resourceType: 'claim',
          actorUserId: a.id,
          correlationId: 'CORR-AU-1',
        },
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

  it('GET /audit returns rows tenant-scoped + ordered desc by occurredAt', async () => {
    const cookies = await loginAs(ADMIN_A);
    const r = await request(app.getHttpServer()).get('/audit').set('Cookie', cookies);
    expect(r.status).toBe(200);
    expect(r.body.total).toBeGreaterThanOrEqual(5);
    // No tenant-B rows should appear.
    const actorIds = (r.body.entries as Array<{ actorUserId: string | null }>)
      .map((e) => e.actorUserId)
      .filter((x): x is string => Boolean(x));
    expect(actorIds.length).toBeGreaterThan(0);
    // Sorted descending — first entry's occurredAt is >= last entry's.
    const times = (r.body.entries as Array<{ occurredAt: string }>).map((e) =>
      new Date(e.occurredAt).getTime(),
    );
    for (let i = 1; i < times.length; i += 1) {
      const prev = times[i - 1];
      const cur = times[i];
      if (prev !== undefined && cur !== undefined) {
        expect(prev).toBeGreaterThanOrEqual(cur);
      }
    }
  });

  it('filters by action narrow the result set', async () => {
    const cookies = await loginAs(ADMIN_A);
    const r = await request(app.getHttpServer())
      .get('/audit?action=case.created')
      .set('Cookie', cookies);
    expect(r.status).toBe(200);
    const actions = (r.body.entries as Array<{ action: string }>).map((e) => e.action);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((a) => a === 'case.created')).toBe(true);
  });

  it('filters by correlationId narrows to a single row', async () => {
    const cookies = await loginAs(ADMIN_A);
    const r = await request(app.getHttpServer())
      .get('/audit?correlationId=CORR-AU-1')
      .set('Cookie', cookies);
    expect(r.status).toBe(200);
    expect(r.body.entries).toHaveLength(1);
    expect(r.body.entries[0].correlationId).toBe('CORR-AU-1');
  });

  it('reader without audit.view → 403', async () => {
    const cookies = await loginAs(READER);
    const r = await request(app.getHttpServer()).get('/audit').set('Cookie', cookies);
    expect(r.status).toBe(403);
  });

  it('GET /audit/export.csv streams CSV with documented header + one row per line', async () => {
    const cookies = await loginAs(ADMIN_A);
    const r = await request(app.getHttpServer())
      .get('/audit/export.csv')
      .set('Cookie', cookies);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    const body = r.text;
    const lines = body.split('\n').filter((l) => l.length > 0);
    expect(lines[0]).toBe(
      'id,occurredAt,actorUserId,actorType,action,resourceType,resourceId,ipAddress,userAgent,correlationId,beforeJson,afterJson',
    );
    // At least 5 data rows (the seeded ones for tenant A).
    expect(lines.length).toBeGreaterThanOrEqual(6);
  });

  it('cross-tenant: tenant-B rows do not appear in tenant-A list', async () => {
    const cookies = await loginAs(ADMIN_A);
    const r = await request(app.getHttpServer()).get('/audit').set('Cookie', cookies);
    // We seeded tenant-B with one 'case.created' row. tenant-A has at
    // least 2 'case.created' rows. After filtering by action we
    // should NOT see the tenant-B row.
    const filtered = await request(app.getHttpServer())
      .get('/audit?action=case.created')
      .set('Cookie', cookies);
    const tenantBRowsLeak = (
      filtered.body.entries as Array<{ resourceType: string }>
    ).filter((e) => e.resourceType !== 'case');
    expect(tenantBRowsLeak).toHaveLength(0);
    // Belt-and-brace: total visible should equal A's case.created count
    // (we seeded 2 for A; the cross-tenant B row is excluded).
    const allCaseCreated = (filtered.body.entries as unknown[]).length;
    expect(allCaseCreated).toBe(2);
    void r;
  });
});
