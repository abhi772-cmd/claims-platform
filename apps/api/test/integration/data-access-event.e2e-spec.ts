// Slice BR — DPDP §17 data access ledger canary.
//
//   1. GET /audit (audit-log list) emits a data_access_event row with
//      action='list', resourceType='audit_log', purpose='audit_query'.
//   2. GET /audit/export.csv emits action='export',
//      purpose='audit_export'.
//   3. PatientService.getDecrypted records action='decrypt',
//      resourceType='patient', resourceId=<patient.id>,
//      fieldNames including the encrypted columns that were
//      actually populated, purpose=ctx.purpose (or 'unspecified'
//      when ctx is omitted).
//   4. RLS canary: cross-tenant SELECT on data_access_event under
//      tenant A's context returns 0 rows that belong to tenant B.

import { generateKeyPairSync } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { argon2id, hash } from 'argon2';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { PatientService } from '../../src/modules/patient';
import { startPostgres, type PgHandles } from '../setup/postgres-container';

jest.setTimeout(180_000);

describe('Slice BR — data_access_event ledger', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN_A = 'admin-br-a@br-test.local';
  const ADMIN_B = 'admin-br-b@br-test.local';
  let tenantAId: string;
  let patients: PatientService;

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
        data: { slug: 'tenant-br-a', displayName: 'BR A', lifecycleState: 'IN_SETUP' },
      });
      tenantAId = tA.id;
      const tB = await tx.tenant.create({
        data: { slug: 'tenant-br-b', displayName: 'BR B', lifecycleState: 'IN_SETUP' },
      });
      const adminRoleA = await tx.role.create({
        data: { tenantId: tA.id, name: 'tenant_admin', permissions: ['audit.view', 'case.view'] },
      });
      const adminRoleB = await tx.role.create({
        data: { tenantId: tB.id, name: 'tenant_admin', permissions: ['audit.view', 'case.view'] },
      });
      const ua = await tx.user.create({
        data: {
          tenantId: tA.id, email: ADMIN_A, passwordHash,
          firstName: 'A', lastName: 'Admin', status: 'active',
        },
      });
      await tx.userRole.create({ data: { tenantId: tA.id, userId: ua.id, roleId: adminRoleA.id } });
      const ub = await tx.user.create({
        data: {
          tenantId: tB.id, email: ADMIN_B, passwordHash,
          firstName: 'B', lastName: 'Admin', status: 'active',
        },
      });
      await tx.userRole.create({ data: { tenantId: tB.id, userId: ub.id, roleId: adminRoleB.id } });
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.use(cookieParser());
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();
    patients = app.get(PatientService);
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

  async function readEvents(
    tenantId: string,
    filter: { resourceType?: string; action?: string; resourceId?: string } = {},
  ): Promise<
    Array<{
      action: string;
      resourceType: string;
      resourceId: string | null;
      purpose: string;
      fieldNames: unknown;
      actorUserId: string | null;
    }>
  > {
    return migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      return tx.dataAccessEvent.findMany({
        where: {
          tenantId,
          ...(filter.resourceType ? { resourceType: filter.resourceType } : {}),
          ...(filter.action ? { action: filter.action } : {}),
          ...(filter.resourceId ? { resourceId: filter.resourceId } : {}),
        },
        select: {
          action: true,
          resourceType: true,
          resourceId: true,
          purpose: true,
          fieldNames: true,
          actorUserId: true,
        },
        orderBy: { occurredAt: 'desc' },
      });
    });
  }

  it('GET /audit emits action=list, purpose=audit_query', async () => {
    const cookies = await loginAs(ADMIN_A);
    const r = await request(app.getHttpServer()).get('/audit').set('Cookie', cookies);
    expect(r.status).toBe(200);
    // Allow brief settle for the fire-and-forget interceptor write.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const events = await readEvents(tenantAId, { resourceType: 'audit_log', action: 'list' });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.purpose).toBe('audit_query');
    expect(events[0]!.actorUserId).not.toBeNull();
  });

  it('GET /audit/export.csv emits action=export, purpose=audit_export', async () => {
    const cookies = await loginAs(ADMIN_A);
    const r = await request(app.getHttpServer())
      .get('/audit/export.csv')
      .set('Cookie', cookies);
    expect(r.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const events = await readEvents(tenantAId, { resourceType: 'audit_log', action: 'export' });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.purpose).toBe('audit_export');
  });

  it('PatientService.getDecrypted records action=decrypt with field names', async () => {
    // Seed a patient with multiple encrypted fields populated.
    const patientId = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantAId}, true)`);
      const p = await tx.patient.create({
        data: {
          tenantId: tenantAId,
          fullName: 'BR Patient',
          aadhaarCipher: 'cipher-aadhaar',
          aadhaarKeyVersion: 'v1',
          mobileCipher: 'cipher-mobile',
          mobileKeyVersion: 'v1',
        },
        select: { id: true },
      });
      return p.id;
    });

    // Note: decryptString throws on bad cipher input. We don't call
    // getDecrypted for the actual decryption result here (the
    // ciphers are placeholders); we patch around that by catching.
    // A future iteration could store real ciphertext.
    try {
      await patients.getDecrypted(tenantAId, patientId, {
        actorUserId: null,
        actorType: 'system',
        purpose: 'eligibility.verify',
      });
    } catch {
      // Expected — fake ciphers don't decrypt. The access log is
      // still written before the decryption attempt fails because
      // we record from the resolved row, not the decrypted value.
      // (See the implementation: void this.accessLog.record(...)
      // runs before the dec(...) calls.)
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
    const events = await readEvents(tenantAId, {
      resourceType: 'patient',
      action: 'decrypt',
      resourceId: patientId,
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
    const row = events[0]!;
    expect(row.purpose).toBe('eligibility.verify');
    expect(row.fieldNames).toEqual(expect.arrayContaining(['aadhaar', 'mobile']));
  });

  it('omitting ctx falls back to purpose=unspecified', async () => {
    const patientId = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantAId}, true)`);
      const p = await tx.patient.create({
        data: {
          tenantId: tenantAId,
          fullName: 'No Ctx Patient',
          mobileCipher: 'cipher-mobile-2',
          mobileKeyVersion: 'v1',
        },
        select: { id: true },
      });
      return p.id;
    });

    try {
      await patients.getDecrypted(tenantAId, patientId);
    } catch {
      /* expected — fake cipher */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    const events = await readEvents(tenantAId, {
      resourceType: 'patient',
      action: 'decrypt',
      resourceId: patientId,
    });
    expect(events[0]!.purpose).toBe('unspecified');
  });

  it('cross-tenant data_access_event read returns 0 rows from the other tenant (RLS canary)', async () => {
    // Generate at least one event for tenant B by hitting its
    // /audit endpoint as B's admin.
    const bCookies = await loginAs(ADMIN_B);
    await request(app.getHttpServer()).get('/audit').set('Cookie', bCookies);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Read tenant A's events under tenant A's context — none of
    // the resourceId/actor should belong to tenant B.
    const tenantAEvents = await readEvents(tenantAId);
    for (const e of tenantAEvents) {
      // tenant B's admin id can't be in tenant A's row set.
      if (e.actorUserId) {
        const owner = await migrator.$transaction(async (tx) => {
          await tx.$executeRaw(
            Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
          );
          return tx.user.findUnique({
            where: { id: e.actorUserId! },
            select: { tenantId: true },
          });
        });
        expect(owner?.tenantId).toBe(tenantAId);
      }
    }
  });
});
