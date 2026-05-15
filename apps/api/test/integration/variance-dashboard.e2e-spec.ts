// T3-1 integration test — CFO variance dashboard.
//
// Drives three claims through to populated billed/approved/paid
// amounts, then verifies all three endpoints:
//   1. GET /analytics/variance/summary — KPI totals + aging buckets
//   2. GET /analytics/variance/by-payer — ordered leakage
//   3. GET /analytics/variance/claims — drill-down + bucket filter
//   4. RBAC: reader without analytics.view → 403
//   5. Cross-tenant: tenant A doesn't see tenant B's claims

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

interface PlantedClaim {
  caseId: string;
  claimId: string;
  payerCode: string;
  claimAmount: number;
  approvedAmount: number;
  paidAmount: number;
  status: string;
  submittedAt: Date;
}

describe('T3-1 — CFO variance dashboard', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN_A = 'admin-va@va-test.local';
  const READER_A = 'reader-va@va-test.local';
  const ADMIN_B = 'admin-vb@va-test.local';
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
    process.env['NHCX_STUB_VERIFY_DEFAULT'] = 'true';
    process.env['NOTIFICATION_RETRY_DISABLED'] = 'true';
    process.env['DOC_LIFECYCLE_DISABLED'] = 'true';

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );

      // Tenant A: admin (analytics.view) + reader (no analytics.view).
      const tA = await tx.tenant.create({
        data: { slug: 'tenant-va', displayName: 'Variance A', lifecycleState: 'IN_SETUP' },
      });
      tenantA = tA.id;
      const adminRoleA = await tx.role.create({
        data: {
          tenantId: tA.id,
          name: 'tenant_admin',
          permissions: ['case.view', 'analytics.view'],
        },
      });
      const readerRoleA = await tx.role.create({
        data: { tenantId: tA.id, name: 'reader', permissions: ['case.view'] },
      });
      const a = await tx.user.create({
        data: {
          tenantId: tA.id,
          email: ADMIN_A,
          passwordHash,
          firstName: 'VA',
          lastName: 'Admin',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tA.id, userId: a.id, roleId: adminRoleA.id },
      });
      const r = await tx.user.create({
        data: {
          tenantId: tA.id,
          email: READER_A,
          passwordHash,
          firstName: 'VA',
          lastName: 'Reader',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tA.id, userId: r.id, roleId: readerRoleA.id },
      });

      // Tenant B: admin with analytics.view to prove cross-tenant
      // isolation (B's claims must NOT leak into A's summary).
      const tB = await tx.tenant.create({
        data: { slug: 'tenant-vb', displayName: 'Variance B', lifecycleState: 'IN_SETUP' },
      });
      tenantB = tB.id;
      const adminRoleB = await tx.role.create({
        data: {
          tenantId: tB.id,
          name: 'tenant_admin',
          permissions: ['case.view', 'analytics.view'],
        },
      });
      const b = await tx.user.create({
        data: {
          tenantId: tB.id,
          email: ADMIN_B,
          passwordHash,
          firstName: 'VB',
          lastName: 'Admin',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tB.id, userId: b.id, roleId: adminRoleB.id },
      });
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.use(cookieParser());
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();

    // Plant claims directly via the migrator under platform_admin
    // RLS. We bypass the full preauth+claim flow because variance
    // numbers are read-only over the materialised state — the
    // dashboard contract is "given these column values, return
    // these aggregates". Each plant sets status + amounts + payerCode
    // + submittedAt explicitly so the test asserts the math, not
    // the upstream state machine.
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const planted: Array<{ tenantId: string; row: PlantedClaim }> = [
      // Tenant A — three claims with different payers + aging.
      {
        tenantId: tenantA,
        row: {
          caseId: '',
          claimId: '',
          payerCode: 'MEDIASSIST',
          claimAmount: 100_000,
          approvedAmount: 90_000, // 10k variance
          paidAmount: 85_000, // 5k short-pay
          status: 'PAYMENT_SHORT_PAID',
          submittedAt: new Date(now - 4 * dayMs), // bucket d0_7
        },
      },
      {
        tenantId: tenantA,
        row: {
          caseId: '',
          claimId: '',
          payerCode: 'MEDIASSIST',
          claimAmount: 200_000,
          approvedAmount: 180_000, // 20k variance
          paidAmount: 0,
          status: 'PAYMENT_PENDING',
          submittedAt: new Date(now - 20 * dayMs), // bucket d15_30
        },
      },
      {
        tenantId: tenantA,
        row: {
          caseId: '',
          claimId: '',
          payerCode: 'PARAMOUNT',
          claimAmount: 50_000,
          approvedAmount: 50_000, // no variance
          paidAmount: 0,
          status: 'PAYMENT_PENDING',
          submittedAt: new Date(now - 40 * dayMs), // bucket d31_plus
        },
      },
      // Tenant B — totally separate; must not show up in A's summary.
      {
        tenantId: tenantB,
        row: {
          caseId: '',
          claimId: '',
          payerCode: 'STAR_HEALTH',
          claimAmount: 999_999,
          approvedAmount: 999_999,
          paidAmount: 999_999,
          status: 'CLAIM_CLOSED',
          submittedAt: new Date(now - 2 * dayMs),
        },
      },
    ];

    for (const p of planted) {
      await migrator.$transaction(async (tx) => {
        await tx.$executeRaw(
          Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
        );
        const c = await tx.case.create({
          data: {
            tenantId: p.tenantId,
            patientName: `Patient-${p.row.payerCode}`,
            hospitalMrn: `MRN-${p.row.payerCode}-${Math.floor(Math.random() * 100000)}`,
            admissionDate: new Date(now - 30 * dayMs),
            admissionType: 'planned',
            primaryRail: 'nhcx',
            createdById: '00000000-0000-0000-0000-000000000000',
          },
        });
        p.row.caseId = c.id;
        const cl = await tx.claim.create({
          data: {
            tenantId: p.tenantId,
            caseId: c.id,
            rail: 'nhcx',
            status: p.row.status,
            claimAmount: p.row.claimAmount,
            approvedAmount: p.row.approvedAmount,
            paidAmount: p.row.paidAmount,
            payerCode: p.row.payerCode,
            submittedAt: p.row.submittedAt,
            claimRefNum: `REF-${p.row.payerCode}-${Math.floor(Math.random() * 100000)}`,
          },
        });
        p.row.claimId = cl.id;
      });
    }
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

  it('GET /summary returns rolled-up KPIs scoped to the tenant', async () => {
    const cookies = await loginAs(ADMIN_A);
    const res = await request(app.getHttpServer())
      .get('/analytics/variance/summary')
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    // 350k billed, 320k approved, 85k paid across 3 claims.
    expect(res.body.totalBilled).toBe(350_000);
    expect(res.body.totalApproved).toBe(320_000);
    expect(res.body.totalPaid).toBe(85_000);
    expect(res.body.totalBilledVariance).toBe(30_000); // 10k + 20k + 0
    expect(res.body.totalShortPay).toBe(5_000); // only the SHORT_PAID claim contributes
    expect(res.body.totalNetLeakage).toBe(35_000);
    expect(res.body.contributingClaimCount).toBe(3);
    // Tenant B's 999_999 claim must NOT show up.
    expect(res.body.totalBilled).not.toBe(350_000 + 999_999);

    // Aging buckets cover unsettled claims only (PAYMENT_PENDING /
    // PAYMENT_SHORT_PAID). The SHORT_PAID 4-day claim → d0_7,
    // the 20-day pending → d15_30, the 40-day pending → d31_plus.
    const buckets = (res.body.aging as Array<{ bucket: string; count: number }>).reduce(
      (acc, row) => ({ ...acc, [row.bucket]: row.count }),
      {} as Record<string, number>,
    );
    expect(buckets['d0_7']).toBe(1);
    expect(buckets['d15_30']).toBe(1);
    expect(buckets['d31_plus']).toBe(1);
    // No 8-14 day claims were planted.
    expect(buckets['d8_14']).toBeUndefined();
  });

  it('GET /by-payer orders by netLeakage desc with correct rates', async () => {
    const cookies = await loginAs(ADMIN_A);
    const res = await request(app.getHttpServer())
      .get('/analytics/variance/by-payer?limit=10')
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    const rows = res.body.rows as Array<{
      payerCode: string;
      netLeakage: number;
      varianceRate: number;
      claimCount: number;
    }>;
    expect(rows.length).toBe(2);
    expect(rows[0]?.payerCode).toBe('MEDIASSIST'); // bigger leakage
    expect(rows[0]?.netLeakage).toBe(35_000); // 10k + 5k short-pay + 20k
    expect(rows[0]?.claimCount).toBe(2);
    expect(rows[1]?.payerCode).toBe('PARAMOUNT');
    expect(rows[1]?.netLeakage).toBe(0);
  });

  it('GET /claims supports bucket filter (d31_plus → 1 claim)', async () => {
    const cookies = await loginAs(ADMIN_A);
    const res = await request(app.getHttpServer())
      .get('/analytics/variance/claims?bucket=d31_plus')
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBe(1);
    expect(res.body.rows[0].payerCode).toBe('PARAMOUNT');
    expect(res.body.rows[0].agingDays).toBeGreaterThanOrEqual(31);
  });

  it('GET /claims supports payerCode filter', async () => {
    const cookies = await loginAs(ADMIN_A);
    const res = await request(app.getHttpServer())
      .get('/analytics/variance/claims?payerCode=MEDIASSIST')
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBe(2);
    expect(
      (res.body.rows as Array<{ payerCode: string }>).every(
        (r) => r.payerCode === 'MEDIASSIST',
      ),
    ).toBe(true);
  });

  it('rejects invalid bucket value with VALIDATION_FAILED', async () => {
    const cookies = await loginAs(ADMIN_A);
    const res = await request(app.getHttpServer())
      .get('/analytics/variance/claims?bucket=garbage')
      .set('Cookie', cookies);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('reader without analytics.view → 403 on all three endpoints', async () => {
    const cookies = await loginAs(READER_A);
    const r1 = await request(app.getHttpServer())
      .get('/analytics/variance/summary')
      .set('Cookie', cookies);
    expect(r1.status).toBe(403);
    const r2 = await request(app.getHttpServer())
      .get('/analytics/variance/by-payer')
      .set('Cookie', cookies);
    expect(r2.status).toBe(403);
    const r3 = await request(app.getHttpServer())
      .get('/analytics/variance/claims')
      .set('Cookie', cookies);
    expect(r3.status).toBe(403);
  });

  it('cross-tenant: tenant B sees only its own claim, not tenant A', async () => {
    const cookies = await loginAs(ADMIN_B);
    const res = await request(app.getHttpServer())
      .get('/analytics/variance/summary')
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.totalBilled).toBe(999_999);
    expect(res.body.totalApproved).toBe(999_999);
    expect(res.body.totalPaid).toBe(999_999);
    expect(res.body.totalBilledVariance).toBe(0);
  });
});
