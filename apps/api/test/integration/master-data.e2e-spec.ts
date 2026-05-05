// Slice O integration test — master data: payer, package, ICD, billing,
// document checklist rules.
//
//   1. List payers (any authenticated user with payer.master.view).
//   2. Create payer requires payer.master.edit + platform_admin GUC RLS.
//   3. Reader without payer.master.edit → 403 on POST.
//   4. ICD search with ?q= filter returns matching codes.
//   5. Document-checklist resolve: phase-specific overrides phase='all'.
//   6. RLS canary: a request with NO authenticated context (no GUC)
//      cannot SELECT payer rows. We exercise this by hitting the
//      claims_app role directly via Prisma.
//   7. Cross-tenant SELECT: payer is platform-level so both tenants see
//      the same list — verifies SELECT is permissive on role 'tenant'.

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

describe('Slice O — master data + checklist resolve', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN_A = 'admin-md-a@md-test.local';
  const ADMIN_B = 'admin-md-b@md-test.local';
  const READER = 'reader-md@md-test.local';

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

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const tenantA = await tx.tenant.create({
        data: { slug: 'tenant-md-a', displayName: 'MD A', lifecycleState: 'IN_SETUP' },
      });
      const tenantB = await tx.tenant.create({
        data: { slug: 'tenant-md-b', displayName: 'MD B', lifecycleState: 'IN_SETUP' },
      });
      const adminRoleA = await tx.role.create({
        data: {
          tenantId: tenantA.id,
          name: 'tenant_admin',
          permissions: [
            'payer.master.view',
            'payer.master.edit',
            'package.master.sync',
            'document_checklist.edit',
          ],
        },
      });
      const readerRole = await tx.role.create({
        data: {
          tenantId: tenantA.id,
          name: 'reader',
          permissions: ['payer.master.view'],
        },
      });
      const adminRoleB = await tx.role.create({
        data: {
          tenantId: tenantB.id,
          name: 'tenant_admin',
          permissions: ['payer.master.view'],
        },
      });
      const a = await tx.user.create({
        data: {
          tenantId: tenantA.id,
          email: ADMIN_A,
          passwordHash,
          firstName: 'MD',
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
          firstName: 'MD',
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
          firstName: 'MD',
          lastName: 'AdminB',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tenantB.id, userId: b.id, roleId: adminRoleB.id },
      });

      // Pre-seed a couple of master-data rows so reads have something
      // to return regardless of test ordering.
      await tx.payer.create({
        data: {
          code: 'MEDIASSIST',
          name: 'Medi Assist',
          payerType: 'private_tpa',
          rail: 'nhcx',
          hcxCode: 'MAHIPL',
        },
      });
      await tx.payer.create({
        data: {
          code: 'STAR_HEALTH',
          name: 'Star Health',
          payerType: 'private_insurer',
          rail: 'nhcx',
        },
      });
      await tx.icdCode.create({
        data: { code: 'I10', description: 'Essential hypertension', chapter: 'IX' },
      });
      await tx.icdCode.create({
        data: { code: 'J18.9', description: 'Pneumonia, unspecified organism', chapter: 'X' },
      });
      // Two checklist rules: 'all' phase fallback + a phase-specific override
      // for the same documentType. resolveChecklist must pick the override.
      await tx.documentChecklistRule.create({
        data: {
          phase: 'all',
          rail: 'nhcx',
          documentType: 'preauth_form',
          required: false,
        },
      });
      await tx.documentChecklistRule.create({
        data: {
          phase: 'preauth',
          rail: 'nhcx',
          documentType: 'preauth_form',
          required: true,
        },
      });
      await tx.documentChecklistRule.create({
        data: {
          phase: 'claim',
          rail: 'nhcx',
          documentType: 'final_bill',
          required: true,
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

  it('GET /payers returns the seeded master-data list', async () => {
    const cookies = await loginAs(ADMIN_A);
    const r = await request(app.getHttpServer()).get('/payers').set('Cookie', cookies);
    expect(r.status).toBe(200);
    expect(r.body.total).toBeGreaterThanOrEqual(2);
    const codes = (r.body.payers as Array<{ code: string }>).map((p) => p.code);
    expect(codes).toContain('MEDIASSIST');
  });

  it('POST /payers creates a new payer with platform_admin RLS context', async () => {
    const cookies = await loginAs(ADMIN_A);
    const r = await request(app.getHttpServer())
      .post('/payers')
      .set('Cookie', cookies)
      .send({
        code: 'NIVA_BUPA',
        name: 'Niva Bupa',
        payerType: 'private_insurer',
        rail: 'nhcx',
      });
    expect(r.status).toBe(201);
    expect(r.body.payer.code).toBe('NIVA_BUPA');

    // Duplicate code → 422
    const dup = await request(app.getHttpServer())
      .post('/payers')
      .set('Cookie', cookies)
      .send({
        code: 'NIVA_BUPA',
        name: 'Niva Bupa',
        payerType: 'private_insurer',
        rail: 'nhcx',
      });
    expect(dup.status).toBe(422);
  });

  it('reader without payer.master.edit cannot create payer → 403', async () => {
    const cookies = await loginAs(READER);
    const r = await request(app.getHttpServer())
      .post('/payers')
      .set('Cookie', cookies)
      .send({
        code: 'CIGNA',
        name: 'Cigna',
        payerType: 'private_insurer',
        rail: 'nhcx',
      });
    expect(r.status).toBe(403);
  });

  it('GET /icd-codes?q= filters by code or description', async () => {
    const cookies = await loginAs(ADMIN_A);
    const byCode = await request(app.getHttpServer())
      .get('/icd-codes?q=I10')
      .set('Cookie', cookies);
    expect(byCode.status).toBe(200);
    const codes = (byCode.body.codes as Array<{ code: string }>).map((c) => c.code);
    expect(codes).toContain('I10');

    const byDesc = await request(app.getHttpServer())
      .get('/icd-codes?q=pneumonia')
      .set('Cookie', cookies);
    expect(byDesc.status).toBe(200);
    const descCodes = (byDesc.body.codes as Array<{ code: string }>).map((c) => c.code);
    expect(descCodes).toContain('J18.9');
  });

  it('checklist resolve: phase-specific rule wins over phase=all', async () => {
    const cookies = await loginAs(ADMIN_A);
    const r = await request(app.getHttpServer())
      .get('/document-checklist-rules/resolve?phase=preauth&rail=nhcx')
      .set('Cookie', cookies);
    expect(r.status).toBe(200);
    const items = r.body.items as Array<{ documentType: string; required: boolean }>;
    const preauthForm = items.find((i) => i.documentType === 'preauth_form');
    // The phase='all' rule had required=false; the phase='preauth' override
    // must win → required=true.
    expect(preauthForm?.required).toBe(true);

    // claim phase has its own rule for final_bill (required=true). The
    // phase='all' rule for preauth_form (required=false) falls through
    // because no claim-specific rule overrides it.
    const claim = await request(app.getHttpServer())
      .get('/document-checklist-rules/resolve?phase=claim&rail=nhcx')
      .set('Cookie', cookies);
    expect(claim.status).toBe(200);
    const claimItems = claim.body.items as Array<{ documentType: string; required: boolean }>;
    expect(claimItems.find((i) => i.documentType === 'final_bill')?.required).toBe(true);
    expect(claimItems.find((i) => i.documentType === 'preauth_form')?.required).toBe(false);
  });

  it('RLS canary: claims_app without GUC cannot SELECT payer rows', async () => {
    // claims_app role with no app.role / app.tenant_id GUC set. The SELECT
    // policy requires role IN ('platform_admin', 'tenant') so this returns
    // zero rows even though the table has data.
    const appClient = new PrismaClient({ datasources: { db: { url: pg.appUrl } } });
    try {
      const rows = await appClient.payer.findMany();
      expect(rows.length).toBe(0);
    } finally {
      await appClient.$disconnect();
    }
  });

  it('cross-tenant: tenant B sees the same platform-level payer list', async () => {
    const cookiesA = await loginAs(ADMIN_A);
    const cookiesB = await loginAs(ADMIN_B);
    const a = await request(app.getHttpServer()).get('/payers').set('Cookie', cookiesA);
    const b = await request(app.getHttpServer()).get('/payers').set('Cookie', cookiesB);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.total).toBe(b.body.total);
  });
});
