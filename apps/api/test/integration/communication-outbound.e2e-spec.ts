// Stage 5 — hospital-initiated communication/request.
//
//   1. Permission gate: a user without communication.send → 403.
//   2. Happy path: POST → 200 + correlationId/sentAt; an outbound
//      integration_message row + an inbound row (markSucceeded) +
//      a claim_event of type `communication.outbound_sent` (with
//      resultingStatus == current claim status, i.e. no transition).
//   3. listForCase: GET returns the outbound entry.
//   4. Empty text → 422 (validation gate).
//   5. The recordInbound service method appends an inbound
//      claim_event for a payer-initiated note (idempotent on
//      correlationId).

import { generateKeyPairSync } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { argon2id, hash } from 'argon2';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { CommunicationService } from '../../src/modules/communication';
import { startPostgres, type PgHandles } from '../setup/postgres-container';

jest.setTimeout(180_000);

describe('Stage 5 — communication outbound + inbound recording', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN = 'admin-comm@comm-test.local';
  const READER = 'reader-comm@comm-test.local';
  let tenantId = '';

  const ADMIN_PERMS = [
    'case.create',
    'case.view',
    'case.assign',
    'preauth.draft',
    'preauth.submit',
    'communication.send',
    'communication.view',
  ];
  const READER_PERMS = ['case.view'];

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
      const tenant = await tx.tenant.create({
        data: {
          slug: 'tenant-comm',
          displayName: 'Comm Tenant',
          lifecycleState: 'IN_SETUP',
        },
      });
      tenantId = tenant.id;

      const adminRole = await tx.role.create({
        data: { tenantId, name: 'tenant_admin', permissions: ADMIN_PERMS },
      });
      const adminUser = await tx.user.create({
        data: {
          tenantId,
          email: ADMIN,
          passwordHash,
          firstName: 'Comm',
          lastName: 'Admin',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId, userId: adminUser.id, roleId: adminRole.id },
      });

      const readerRole = await tx.role.create({
        data: { tenantId, name: 'read_only', permissions: READER_PERMS },
      });
      const readerUser = await tx.user.create({
        data: {
          tenantId,
          email: READER,
          passwordHash,
          firstName: 'Comm',
          lastName: 'Reader',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId, userId: readerUser.id, roleId: readerRole.id },
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

  async function createCase(cookies: string[]): Promise<{ caseId: string; claimId: string }> {
    const create = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'Comm Patient',
        hospitalMrn: 'MRN-COMM-1',
        admissionDate: '2026-05-08',
        admissionType: 'planned',
        primaryRail: 'nhcx',
      });
    expect(create.status).toBe(201);
    return { caseId: create.body.id as string, claimId: create.body.claims[0].id as string };
  }

  it('rejects users without communication.send (403)', async () => {
    const adminCookies = await loginAs(ADMIN);
    const { caseId, claimId } = await createCase(adminCookies);

    const readerCookies = await loginAs(READER);
    const r = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/communications`)
      .set('Cookie', readerCookies)
      .send({ text: 'Why was the variance so high?' });
    expect(r.status).toBe(403);
  });

  it('happy path: POST → 200, integration ledger has outbound+inbound, claim_event has communication.outbound_sent', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await createCase(cookies);

    const beforeStatus = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      const c = await tx.claim.findUniqueOrThrow({ where: { id: claimId } });
      return c.status;
    });

    const r = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/communications`)
      .set('Cookie', cookies)
      .send({ text: 'Please clarify the line items deducted.' });
    expect(r.status).toBe(200);
    expect(typeof r.body.correlationId).toBe('string');
    expect(typeof r.body.sentAt).toBe('string');
    const correlationId = r.body.correlationId as string;

    // Two integration_message rows: outbound succeeded + inbound succeeded.
    const ledger = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      return tx.integrationMessage.findMany({
        where: { correlationId, integration: 'nhcx' },
        orderBy: { direction: 'asc' },
      });
    });
    expect(ledger.length).toBeGreaterThanOrEqual(2);
    const outbound = ledger.find((m) => m.direction === 'outbound');
    const inbound = ledger.find((m) => m.direction === 'inbound');
    expect(outbound?.status).toBe('succeeded');
    expect(outbound?.operation).toBe('communication.request');
    expect(inbound?.status).toBe('succeeded');

    // ClaimEvent: communication.outbound_sent at SAME status as before.
    const event = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      return tx.claimEvent.findFirst({
        where: { claimId, eventType: 'communication.outbound_sent' },
        orderBy: { occurredAt: 'desc' },
      });
    });
    expect(event).not.toBeNull();
    expect(event?.resultingStatus).toBe(beforeStatus);
    expect(event?.correlationId).toBe(correlationId);
    const payload = (event?.payload ?? {}) as { text?: string; direction?: string };
    expect(payload.text).toBe('Please clarify the line items deducted.');
    expect(payload.direction).toBe('outbound');

    // Claim status should NOT have moved.
    const afterClaim = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      return tx.claim.findUniqueOrThrow({ where: { id: claimId } });
    });
    expect(afterClaim.status).toBe(beforeStatus);

    // listForCase returns the entry.
    const list = await request(app.getHttpServer())
      .get(`/cases/${caseId}/communications`)
      .set('Cookie', cookies);
    expect(list.status).toBe(200);
    expect(list.body.entries.length).toBeGreaterThanOrEqual(1);
    const entry = list.body.entries.find(
      (e: { correlationId: string }) => e.correlationId === correlationId,
    );
    expect(entry).toBeDefined();
    expect(entry.direction).toBe('outbound');
    expect(entry.text).toBe('Please clarify the line items deducted.');
  });

  it('empty text → 422 validation', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await createCase(cookies);
    const r = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/communications`)
      .set('Cookie', cookies)
      .send({ text: '' });
    expect(r.status).toBe(422);
  });

  it('recordInbound appends a non-transitioning claim_event and is idempotent', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await createCase(cookies);
    void caseId;
    const svc = app.get(CommunicationService);
    const correlationId = '11111111-2222-3333-4444-555555555555';
    await svc.recordInbound({
      tenantId,
      claimId,
      text: 'Please share the discharge summary.',
      correlationId,
    });
    // Second call same correlation → no second row.
    await svc.recordInbound({
      tenantId,
      claimId,
      text: 'Please share the discharge summary.',
      correlationId,
    });
    const rows = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      return tx.claimEvent.findMany({
        where: { claimId, eventType: 'communication.inbound_received' },
      });
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.correlationId).toBe(correlationId);
  });
});
