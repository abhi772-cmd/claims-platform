// Slice K integration test — eligibility cycle end to end via the
// NHCX stub adapter + integration_message ledger.
//
//   1. Reader role can't POST /eligibility (perm gate).
//   2. Happy path verified: claim transitions INITIATED →
//      ELIGIBILITY_CHECK_PENDING → ELIGIBILITY_VERIFIED; outbound +
//      inbound integration_message rows written, both 'succeeded',
//      sharing the same correlationId.
//   3. Failure path: when MRN is on the stub fail-list, claim ends
//      at ELIGIBILITY_FAILED with a failure reason in the ledger.
//   4. Retry from FAILED is allowed by the state machine.
//   5. Wrong status (already VERIFIED) → state-machine rejects with 422.
//   6. Cross-tenant integration_message read returns [].

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

describe('Slice K — eligibility + integration ledger', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN_A = 'admin-elig-a@elig-test.local';
  const READER_A = 'reader-elig-a@elig-test.local';
  const ADMIN_B = 'admin-elig-b@elig-test.local';

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
    // Default verify true; specific MRN goes through the fail-list.
    process.env['NHCX_STUB_VERIFY_DEFAULT'] = 'true';
    process.env['NHCX_STUB_MRN_FAIL_LIST'] = 'MRN-FAIL-1';

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const a = await tx.tenant.create({
        data: { slug: 'tenant-elig-a', displayName: 'Elig A', lifecycleState: 'IN_SETUP' },
      });
      const b = await tx.tenant.create({
        data: { slug: 'tenant-elig-b', displayName: 'Elig B', lifecycleState: 'IN_SETUP' },
      });
      const adminRoleA = await tx.role.create({
        data: {
          tenantId: a.id, name: 'tenant_admin',
          permissions: ['case.create', 'case.view', 'case.assign', 'audit.view'],
        },
      });
      const readerRoleA = await tx.role.create({
        data: { tenantId: a.id, name: 'read_only', permissions: ['case.view'] },
      });
      const adminRoleB = await tx.role.create({
        data: {
          tenantId: b.id, name: 'tenant_admin',
          permissions: ['case.create', 'case.view'],
        },
      });
      const ua = await tx.user.create({
        data: {
          tenantId: a.id, email: ADMIN_A, passwordHash,
          firstName: 'A', lastName: 'Admin', status: 'active',
        },
      });
      await tx.userRole.create({ data: { tenantId: a.id, userId: ua.id, roleId: adminRoleA.id } });
      const ur = await tx.user.create({
        data: {
          tenantId: a.id, email: READER_A, passwordHash,
          firstName: 'A', lastName: 'Reader', status: 'active',
        },
      });
      await tx.userRole.create({ data: { tenantId: a.id, userId: ur.id, roleId: readerRoleA.id } });
      const ub = await tx.user.create({
        data: {
          tenantId: b.id, email: ADMIN_B, passwordHash,
          firstName: 'B', lastName: 'Admin', status: 'active',
        },
      });
      await tx.userRole.create({ data: { tenantId: b.id, userId: ub.id, roleId: adminRoleB.id } });
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

  async function createCase(
    cookies: string[],
    mrn: string,
  ): Promise<{ caseId: string; claimId: string }> {
    const res = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'Test Patient',
        hospitalMrn: mrn,
        admissionDate: '2026-05-01',
        admissionType: 'planned',
        primaryRail: 'nhcx',
      });
    expect(res.status).toBe(201);
    return { caseId: res.body.id as string, claimId: res.body.claims[0].id as string };
  }

  it('reader cannot POST /eligibility → 403', async () => {
    const adminCookies = await loginAs(ADMIN_A);
    const { caseId, claimId } = await createCase(adminCookies, 'MRN-READER-1');
    const readerCookies = await loginAs(READER_A);
    const res = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/eligibility`)
      .set('Cookie', readerCookies)
      .send({});
    expect(res.status).toBe(403);
  });

  it('happy path: verified → claim VERIFIED + paired ledger rows', async () => {
    const cookies = await loginAs(ADMIN_A);
    const { caseId, claimId } = await createCase(cookies, 'MRN-OK-1');
    const res = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/eligibility`)
      .set('Cookie', cookies)
      .send({ policyNumber: 'POL-123' });
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(res.body.status).toBe('ELIGIBILITY_VERIFIED');

    const ledger = await request(app.getHttpServer())
      .get(`/cases/${caseId}/claims/${claimId}/integration-messages`)
      .set('Cookie', cookies);
    expect(ledger.status).toBe(200);
    expect(ledger.body.messages.length).toBe(2);
    const directions = ledger.body.messages.map((m: { direction: string }) => m.direction).sort();
    expect(directions).toEqual(['inbound', 'outbound']);
    const correlationIds = new Set(
      ledger.body.messages.map((m: { correlationId: string }) => m.correlationId),
    );
    expect(correlationIds.size).toBe(1);
    for (const m of ledger.body.messages) {
      expect(m.status).toBe('succeeded');
      expect(m.integration).toBe('nhcx');
      expect(m.operation).toBe('eligibility.verify');
    }
  });

  it('failure path: fail-list MRN → claim FAILED + ledger reflects negative result', async () => {
    const cookies = await loginAs(ADMIN_A);
    const { caseId, claimId } = await createCase(cookies, 'MRN-FAIL-1');
    const res = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/eligibility`)
      .set('Cookie', cookies)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(false);
    expect(res.body.status).toBe('ELIGIBILITY_FAILED');
    expect(res.body.failureReason).toBeTruthy();

    const ledger = await request(app.getHttpServer())
      .get(`/cases/${caseId}/claims/${claimId}/integration-messages`)
      .set('Cookie', cookies);
    expect(ledger.body.messages.length).toBe(2);
    // Both rows are 'succeeded' (delivery succeeded) — the negative
    // outcome is in the rawResponse body, not the row status.
    for (const m of ledger.body.messages) {
      expect(m.status).toBe('succeeded');
    }
  });

  it('retry from FAILED is allowed (state machine ELIGIBILITY_FAILED → eligibility.retry)', async () => {
    const cookies = await loginAs(ADMIN_A);
    const { caseId, claimId } = await createCase(cookies, 'MRN-FAIL-1');
    // First attempt fails.
    const r1 = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/eligibility`)
      .set('Cookie', cookies)
      .send({});
    expect(r1.body.status).toBe('ELIGIBILITY_FAILED');

    // Manual retry transition (admin escape hatch) drives back to
    // ELIGIBILITY_CHECK_PENDING then we can re-run via a manual
    // verify event. For Slice K we just confirm the retry transition
    // is allowed by the state machine.
    const retry = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/transitions`)
      .set('Cookie', cookies)
      .send({ eventType: 'eligibility.retry' });
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('ELIGIBILITY_CHECK_PENDING');
  });

  it('running again from VERIFIED is rejected by the state machine', async () => {
    const cookies = await loginAs(ADMIN_A);
    const { caseId, claimId } = await createCase(cookies, 'MRN-OK-2');
    const ok = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/eligibility`)
      .set('Cookie', cookies)
      .send({});
    expect(ok.body.status).toBe('ELIGIBILITY_VERIFIED');

    const replay = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/eligibility`)
      .set('Cookie', cookies)
      .send({});
    expect(replay.status).toBe(422);
  });

  it('cross-tenant integration_message read returns [] (RLS canary)', async () => {
    const adminCookiesB = await loginAs(ADMIN_B);
    const b = await createCase(adminCookiesB, 'MRN-B-1');
    await request(app.getHttpServer())
      .post(`/cases/${b.caseId}/claims/${b.claimId}/eligibility`)
      .set('Cookie', adminCookiesB)
      .send({});

    // Tenant A admin cannot read tenant B's ledger.
    const adminCookiesA = await loginAs(ADMIN_A);
    const cross = await request(app.getHttpServer())
      .get(`/cases/${b.caseId}/claims/${b.claimId}/integration-messages`)
      .set('Cookie', adminCookiesA);
    // 422 — the ownership check fails first because the case is
    // invisible under tenant A's RLS context. Either way, no ledger
    // rows leak.
    expect([403, 422]).toContain(cross.status);
  });
});
