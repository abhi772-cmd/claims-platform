// Slice BS — DPDP §8(6) breach detection + notification e2e canary.
//
//   1. Detector raises a BURST_DECRYPT incident when an actor decrypts
//      > threshold distinct patients in the scan window.
//   2. Detector is idempotent — re-running scan() with the same
//      ledger state in the same minute produces no new incidents.
//   3. Manual file via POST /breach-incidents lands a row with
//      kind='MANUAL_REPORT' and a 72h dpdpNotificationDueAt.
//   4. POST /breach-incidents/:id/notify flips status to 'notified'
//      and snapshots the §8(6) template into dpdpNotificationPayload.
//      The body contains the six required sections.
//   5. POST /breach-incidents/:id/dismiss flips status to 'dismissed'
//      with the supplied reason. Notify after dismiss → 422.
//   6. Reader without breach_incident.manage permission cannot file
//      / notify / dismiss (403); can list / view (200) when granted
//      breach_incident.view.
//   7. Cross-tenant GET on tenant B's incident under tenant A's
//      session returns 422 (RLS canary).

import { generateKeyPairSync } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { argon2id, hash } from 'argon2';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { BreachDetectorService } from '../../src/modules/breach/breach-detector.service';
import { startPostgres, type PgHandles } from '../setup/postgres-container';

jest.setTimeout(180_000);

describe('Slice BS — breach detection + notification', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;
  let detector: BreachDetectorService;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN_A = 'admin-bs-a@bs-test.local';
  const VIEWER_A = 'viewer-bs-a@bs-test.local';
  const READER_A = 'reader-bs-a@bs-test.local';
  const ADMIN_B = 'admin-bs-b@bs-test.local';
  let tenantAId: string;
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
        data: { slug: 'tenant-bs-a', displayName: 'BS A', lifecycleState: 'IN_SETUP' },
      });
      tenantAId = tA.id;
      const tB = await tx.tenant.create({
        data: { slug: 'tenant-bs-b', displayName: 'BS B', lifecycleState: 'IN_SETUP' },
      });
      const adminRoleA = await tx.role.create({
        data: {
          tenantId: tA.id,
          name: 'tenant_admin',
          permissions: ['breach_incident.view', 'breach_incident.manage'],
        },
      });
      const viewerRoleA = await tx.role.create({
        data: { tenantId: tA.id, name: 'viewer', permissions: ['breach_incident.view'] },
      });
      const readerRoleA = await tx.role.create({
        data: { tenantId: tA.id, name: 'reader', permissions: ['case.view'] },
      });
      const adminRoleB = await tx.role.create({
        data: {
          tenantId: tB.id,
          name: 'tenant_admin',
          permissions: ['breach_incident.view', 'breach_incident.manage'],
        },
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
      const uv = await tx.user.create({
        data: {
          tenantId: tA.id, email: VIEWER_A, passwordHash,
          firstName: 'A', lastName: 'Viewer', status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tA.id, userId: uv.id, roleId: viewerRoleA.id },
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
    detector = app.get(BreachDetectorService);
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

  // Seed N decrypt events for (tenantId, actorUserId), each touching a
  // distinct patientId. Insert directly under platform_admin context
  // bypassing the access-log service so the test controls occurredAt.
  async function seedDecryptEvents(
    tenantId: string,
    actorUserId: string,
    patientCount: number,
    occurredAt: Date,
  ): Promise<string[]> {
    const ids: string[] = [];
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      for (let i = 0; i < patientCount; i++) {
        const patientId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
        const r = await tx.dataAccessEvent.create({
          data: {
            tenantId,
            actorUserId,
            actorType: 'user',
            resourceType: 'patient',
            resourceId: patientId,
            action: 'decrypt',
            purpose: 'test.bulk',
            fieldNames: ['aadhaar', 'mobile'],
            occurredAt,
          },
          select: { id: true },
        });
        ids.push(r.id);
      }
    });
    return ids;
  }

  it('detector raises BURST_DECRYPT when threshold exceeded; idempotent on rerun', async () => {
    // Threshold is 50 distinct patients per 60min window (default).
    // Seed 60 events 2 minutes ago — comfortably inside the window
    // and above threshold.
    const occurredAt = new Date(Date.now() - 2 * 60 * 1000);
    await seedDecryptEvents(tenantAId, actorAId, 60, occurredAt);

    const r1 = await detector.scan();
    expect(r1.incidentsCreated).toBe(1);
    expect(r1.byKind.BURST_DECRYPT).toBe(1);

    // Re-run within the same minute. windowStart rounds down to the
    // current minute boundary; the unique constraint on
    // (tenantId, kind, actorUserId, windowStart) should prevent a
    // duplicate row.
    const r2 = await detector.scan();
    expect(r2.incidentsCreated).toBe(0);

    // Verify the incident landed with the right shape.
    const cookies = await loginAs(ADMIN_A);
    const list = await request(app.getHttpServer())
      .get('/breach-incidents')
      .set('Cookie', cookies);
    expect(list.status).toBe(200);
    expect(list.body.rows.length).toBeGreaterThanOrEqual(1);
    const burst = list.body.rows.find((row: { kind: string }) => row.kind === 'BURST_DECRYPT');
    expect(burst).toBeDefined();
    expect(burst.severity).toBe('high');
    expect(burst.status).toBe('detected');
    expect(burst.affectedDataPrincipals).toBe(60);
    expect(burst.dataCategories).toEqual(expect.arrayContaining(['aadhaar', 'mobile']));
    expect(burst.evidenceEventIds.length).toBeGreaterThan(0);
  });

  it('manual file lands a MANUAL_REPORT with 72h due deadline', async () => {
    const cookies = await loginAs(ADMIN_A);
    const before = Date.now();
    const r = await request(app.getHttpServer())
      .post('/breach-incidents')
      .set('Cookie', cookies)
      .send({
        severity: 'medium',
        description: 'Vendor confirmed unauthorized access to backup snapshot.',
        dataCategories: ['aadhaar', 'patient'],
        affectedDataPrincipals: 12,
      });
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe('MANUAL_REPORT');
    expect(r.body.severity).toBe('medium');
    expect(r.body.status).toBe('detected');
    expect(r.body.actorUserId).toBeNull();
    expect(r.body.windowStart).toBeNull();

    // dpdpNotificationDueAt should be ~72h ahead of openedAt. Allow
    // 2 minutes of slack for test scheduling jitter.
    const opened = new Date(r.body.openedAt).getTime();
    const due = new Date(r.body.dpdpNotificationDueAt).getTime();
    expect(due - opened).toBeGreaterThanOrEqual(72 * 60 * 60 * 1000 - 60_000);
    expect(due - opened).toBeLessThanOrEqual(72 * 60 * 60 * 1000 + 60_000);
    expect(opened).toBeGreaterThanOrEqual(before - 60_000);
  });

  it('GET /breach-incidents/:id includes a notification preview when status=detected', async () => {
    const cookies = await loginAs(ADMIN_A);
    const filed = await request(app.getHttpServer())
      .post('/breach-incidents')
      .set('Cookie', cookies)
      .send({
        severity: 'high',
        description: 'Detected anomalous bulk access during off-hours sweep.',
        dataCategories: ['mobile'],
        affectedDataPrincipals: 7,
      });
    expect(filed.status).toBe(200);
    const id = filed.body.id;

    const r = await request(app.getHttpServer())
      .get(`/breach-incidents/${id}`)
      .set('Cookie', cookies);
    expect(r.status).toBe(200);
    expect(r.body.incident.id).toBe(id);
    expect(r.body.notificationPreview).not.toBeNull();
    // Body contains all six required §8(6) sections.
    const body = r.body.notificationPreview.body as string;
    for (const section of [
      '1. Description of the breach',
      '2. Approximate number of data principals affected',
      '3. Categories of personal data implicated',
      '4. Likely consequences for affected principals',
      '5. Mitigation measures taken or planned',
      '6. Grievance officer contact',
    ]) {
      expect(body).toContain(section);
    }
  });

  it('notify flips status to notified and captures payload; cannot notify twice', async () => {
    const cookies = await loginAs(ADMIN_A);
    const filed = await request(app.getHttpServer())
      .post('/breach-incidents')
      .set('Cookie', cookies)
      .send({
        severity: 'critical',
        description: 'Cleartext export blob stored on dev laptop, laptop reported stolen.',
        dataCategories: ['aadhaar', 'mobile', 'email'],
        affectedDataPrincipals: 40,
      });
    expect(filed.status).toBe(200);
    const id = filed.body.id;

    const notified = await request(app.getHttpServer())
      .post(`/breach-incidents/${id}/notify`)
      .set('Cookie', cookies)
      .send({ acknowledged: true });
    expect(notified.status).toBe(200);
    expect(notified.body.status).toBe('notified');
    expect(notified.body.dpdpNotificationSentAt).not.toBeNull();
    expect(notified.body.dpdpNotificationPayload).not.toBeNull();
    expect(notified.body.dpdpNotificationPayload.fields.severity).toBe('critical');
    expect(notified.body.processedByUserId).toBe(actorAId);

    // Second notify should reject because status is no longer 'detected'.
    const second = await request(app.getHttpServer())
      .post(`/breach-incidents/${id}/notify`)
      .set('Cookie', cookies)
      .send({ acknowledged: true });
    expect(second.status).toBe(422);
  });

  it('dismiss flips status to dismissed with reason; notify after dismiss → 422', async () => {
    const cookies = await loginAs(ADMIN_A);
    const filed = await request(app.getHttpServer())
      .post('/breach-incidents')
      .set('Cookie', cookies)
      .send({
        severity: 'low',
        description: 'False positive — operator was running an authorized export.',
        dataCategories: ['patient'],
        affectedDataPrincipals: 0,
      });
    expect(filed.status).toBe(200);
    const id = filed.body.id;

    const dismissed = await request(app.getHttpServer())
      .post(`/breach-incidents/${id}/dismiss`)
      .set('Cookie', cookies)
      .send({ reason: 'Authorized monthly export — not a breach.' });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.status).toBe('dismissed');
    expect(dismissed.body.dismissalReason).toContain('Authorized');

    const cantNotify = await request(app.getHttpServer())
      .post(`/breach-incidents/${id}/notify`)
      .set('Cookie', cookies)
      .send({ acknowledged: true });
    expect(cantNotify.status).toBe(422);
  });

  it('viewer with breach_incident.view can list/get but cannot file/notify/dismiss', async () => {
    const adminCookies = await loginAs(ADMIN_A);
    const filed = await request(app.getHttpServer())
      .post('/breach-incidents')
      .set('Cookie', adminCookies)
      .send({
        severity: 'medium',
        description: 'Permissions canary — operator-only filing.',
        dataCategories: ['session_token'],
        affectedDataPrincipals: 3,
      });
    const id = filed.body.id;

    const viewerCookies = await loginAs(VIEWER_A);
    const list = await request(app.getHttpServer())
      .get('/breach-incidents')
      .set('Cookie', viewerCookies);
    expect(list.status).toBe(200);

    const view = await request(app.getHttpServer())
      .get(`/breach-incidents/${id}`)
      .set('Cookie', viewerCookies);
    expect(view.status).toBe(200);

    const file = await request(app.getHttpServer())
      .post('/breach-incidents')
      .set('Cookie', viewerCookies)
      .send({
        severity: 'low',
        description: 'Viewer should not be able to file.',
        dataCategories: ['patient'],
        affectedDataPrincipals: 1,
      });
    expect(file.status).toBe(403);

    const notify = await request(app.getHttpServer())
      .post(`/breach-incidents/${id}/notify`)
      .set('Cookie', viewerCookies)
      .send({ acknowledged: true });
    expect(notify.status).toBe(403);

    const dismiss = await request(app.getHttpServer())
      .post(`/breach-incidents/${id}/dismiss`)
      .set('Cookie', viewerCookies)
      .send({ reason: 'Viewer should not be able to dismiss this.' });
    expect(dismiss.status).toBe(403);
  });

  it('reader without any breach permission cannot list', async () => {
    const cookies = await loginAs(READER_A);
    const r = await request(app.getHttpServer())
      .get('/breach-incidents')
      .set('Cookie', cookies);
    expect(r.status).toBe(403);
  });

  it('cross-tenant GET on tenant B incident under tenant A → 422 (RLS canary)', async () => {
    const bCookies = await loginAs(ADMIN_B);
    const filed = await request(app.getHttpServer())
      .post('/breach-incidents')
      .set('Cookie', bCookies)
      .send({
        severity: 'high',
        description: 'Tenant B incident — should be invisible to tenant A.',
        dataCategories: ['aadhaar'],
        affectedDataPrincipals: 5,
      });
    expect(filed.status).toBe(200);

    const aCookies = await loginAs(ADMIN_A);
    const cross = await request(app.getHttpServer())
      .get(`/breach-incidents/${filed.body.id}`)
      .set('Cookie', aCookies);
    expect(cross.status).toBe(422);
  });
});
