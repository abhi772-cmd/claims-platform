// Slice AG integration test — sender-code allowlist end to end on the
// /nhcx/inbound webhook. Confirms the allowlist:
//   1. is default-permit when empty (the existing inbound tests work
//      without seeding a payer);
//   2. allows known senders (Payer.hcxCode) when the allowlist is
//      non-empty;
//   3. rejects unknown senders without writing an integration_message
//      row;
//   4. rejects missing x-hcx-sender-code header when allowlist
//      enforcement is on.
//
// In all rejection cases the controller still returns 200 (the
// gateway must not retry on a configuration mismatch).

import { generateKeyPairSync } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { argon2id, hash } from 'argon2';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { NhcxSenderAllowlistService } from '../../src/modules/nhcx/inbound/nhcx-sender-allowlist.service';
import { encryptToParticipant } from '../../src/modules/nhcx/nhcx.crypto';
import { startPostgres, type PgHandles } from '../setup/postgres-container';

jest.setTimeout(180_000);

async function readInbound(
  prisma: PrismaClient,
  correlationId: string,
): Promise<{ status: string } | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
    );
    return tx.integrationMessage.findFirst({
      where: {
        correlationId,
        direction: 'inbound',
        integration: 'nhcx',
        operation: 'coverageeligibility/on_check',
      },
      select: { status: true },
    });
  });
}

describe('Slice AG — NHCX inbound sender-code allowlist', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;
  let allowlist: NhcxSenderAllowlistService;
  let ourPublicKeyPem: string;
  let tenantId: string;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN = 'admin-allowlist@allowlist-test.local';

  beforeAll(async () => {
    pg = await startPostgres();
    migrator = new PrismaClient({ datasources: { db: { url: pg.migratorUrl } } });

    const jwt = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const nhcx = generateKeyPairSync('rsa', { modulusLength: 2048 });
    ourPublicKeyPem = nhcx.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const ourPrivateKeyPem = nhcx.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'api';
    process.env['PORT'] = '0';
    process.env['DATABASE_URL'] = pg.appUrl;
    process.env['DATABASE_URL_MIGRATOR'] = pg.migratorUrl;
    process.env['JWT_PRIVATE_KEY_BASE64'] = Buffer.from(
      jwt.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    ).toString('base64');
    process.env['JWT_PUBLIC_KEY_BASE64'] = Buffer.from(
      jwt.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    ).toString('base64');
    process.env['LOG_LEVEL'] = 'warn';
    process.env['CORS_ORIGIN'] = 'http://localhost:3000';
    process.env['WEB_BASE_URL'] = 'http://localhost:3000';
    process.env['SMTP_HOST'] = '127.0.0.1';
    process.env['SMTP_PORT'] = '1';
    process.env['SMTP_FROM'] = 'no-reply@test';
    process.env['NOTIFICATION_RETRY_DISABLED'] = 'true';
    process.env['DOC_LIFECYCLE_DISABLED'] = 'true';
    process.env['NHCX_MODE'] = 'stub';
    process.env['NHCX_STUB_VERIFY_DEFAULT'] = 'true';
    process.env['NHCX_PRIVATE_KEY_BASE64'] = Buffer.from(ourPrivateKeyPem).toString('base64');
    process.env['NHCX_PRIVATE_KEY_VERSION'] = 'v1';

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const tenant = await tx.tenant.create({
        data: {
          slug: 'tenant-allowlist',
          displayName: 'Allowlist',
          lifecycleState: 'IN_SETUP',
        },
      });
      tenantId = tenant.id;
      const role = await tx.role.create({
        data: {
          tenantId: tenant.id,
          name: 'tenant_admin',
          permissions: ['case.create', 'case.view'],
        },
      });
      const u = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: ADMIN,
          passwordHash,
          firstName: 'Allow',
          lastName: 'Admin',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tenant.id, userId: u.id, roleId: role.id },
      });
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.use(cookieParser());
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();
    allowlist = app.get(NhcxSenderAllowlistService);
  });

  afterAll(async () => {
    await app?.close();
    await migrator.$disconnect().catch(() => undefined);
    await pg?.shutdown();
  });

  async function loginAndKickEligibility(
    mrn: string,
  ): Promise<{ correlationId: string }> {
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: ADMIN, password: PASSWORD });
    expect(loginRes.status).toBe(200);
    const cookies = (loginRes.headers['set-cookie'] as unknown as string[] | string | undefined);
    const cookieList = (Array.isArray(cookies) ? cookies : cookies ? [cookies] : [])
      .map((c) => c.split(';')[0])
      .filter((c): c is string => Boolean(c));
    const caseRes = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookieList)
      .send({
        patientName: 'Allow Patient',
        hospitalMrn: mrn,
        admissionDate: '2026-05-01',
        admissionType: 'planned',
        primaryRail: 'nhcx',
      });
    expect(caseRes.status).toBe(201);
    const caseId = caseRes.body.id as string;
    const claimId = caseRes.body.claims[0].id as string;
    const elig = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/eligibility`)
      .set('Cookie', cookieList)
      .send({});
    expect(elig.status).toBe(200);
    return { correlationId: elig.body.correlationId as string };
  }

  async function seedPayer(hcxCode: string | null, active: boolean): Promise<void> {
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      await tx.payer.deleteMany({});
      await tx.payer.create({
        data: {
          code: 'TEST-PAYER',
          name: 'Test Payer',
          payerType: 'private_tpa',
          rail: 'nhcx',
          hcxCode,
          active,
        },
      });
    });
    allowlist.invalidate();
  }

  it('default-permit: empty allowlist allows any sender', async () => {
    // Empty payer table at start of test.
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      await tx.payer.deleteMany({});
    });
    allowlist.invalidate();

    const { correlationId } = await loginAndKickEligibility('MRN-AL-1');
    const jwe = await encryptToParticipant(
      {
        resourceType: 'Bundle',
        type: 'collection',
        entry: [{ resource: { resourceType: 'CoverageEligibilityResponse', outcome: 'complete' } }],
      },
      ourPublicKeyPem,
      'v1',
    );
    const res = await request(app.getHttpServer())
      .post('/nhcx/inbound')
      .set('x-hcx-correlation-id', correlationId)
      .set('x-hcx-operation', 'coverageeligibility/on_check')
      .set('x-hcx-sender-code', 'literally-any-sender@hcx')
      .send({ payload: jwe, type: 'JWEPayload' });
    expect(res.status).toBe(200);

    // Wait briefly for processing then check the inbound row exists.
    await new Promise((r) => setTimeout(r, 200));
    const inbound = await readInbound(migrator, correlationId);
    expect(inbound).not.toBeNull();
  });

  it('non-empty allowlist: known sender allowed', async () => {
    await seedPayer('star-health@hcx', true);
    const { correlationId } = await loginAndKickEligibility('MRN-AL-2');
    const jwe = await encryptToParticipant(
      {
        resourceType: 'Bundle',
        type: 'collection',
        entry: [{ resource: { resourceType: 'CoverageEligibilityResponse', outcome: 'complete' } }],
      },
      ourPublicKeyPem,
      'v1',
    );
    const res = await request(app.getHttpServer())
      .post('/nhcx/inbound')
      .set('x-hcx-correlation-id', correlationId)
      .set('x-hcx-operation', 'coverageeligibility/on_check')
      .set('x-hcx-sender-code', 'star-health@hcx')
      .send({ payload: jwe, type: 'JWEPayload' });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    const inbound = await readInbound(migrator, correlationId);
    expect(inbound).not.toBeNull();
  });

  it('non-empty allowlist: unknown sender rejected, no row written', async () => {
    await seedPayer('star-health@hcx', true);
    const { correlationId } = await loginAndKickEligibility('MRN-AL-3');
    const jwe = await encryptToParticipant(
      {
        resourceType: 'Bundle',
        type: 'collection',
        entry: [{ resource: { resourceType: 'CoverageEligibilityResponse', outcome: 'complete' } }],
      },
      ourPublicKeyPem,
      'v1',
    );
    const res = await request(app.getHttpServer())
      .post('/nhcx/inbound')
      .set('x-hcx-correlation-id', correlationId)
      .set('x-hcx-operation', 'coverageeligibility/on_check')
      .set('x-hcx-sender-code', 'rogue-payer@hcx')
      .send({ payload: jwe, type: 'JWEPayload' });
    // Still 200 — gateway must not retry on a configuration mismatch.
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    const inbound = await readInbound(migrator, correlationId);
    expect(inbound).toBeNull();
  });

  it('non-empty allowlist: missing sender header rejected', async () => {
    await seedPayer('star-health@hcx', true);
    const { correlationId } = await loginAndKickEligibility('MRN-AL-4');
    const jwe = await encryptToParticipant(
      {
        resourceType: 'Bundle',
        type: 'collection',
        entry: [{ resource: { resourceType: 'CoverageEligibilityResponse', outcome: 'complete' } }],
      },
      ourPublicKeyPem,
      'v1',
    );
    const res = await request(app.getHttpServer())
      .post('/nhcx/inbound')
      .set('x-hcx-correlation-id', correlationId)
      .set('x-hcx-operation', 'coverageeligibility/on_check')
      // no x-hcx-sender-code
      .send({ payload: jwe, type: 'JWEPayload' });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    const inbound = await readInbound(migrator, correlationId);
    expect(inbound).toBeNull();
  });

  it('inactive payer is not in the allowlist', async () => {
    await seedPayer('star-health@hcx', false);
    const { correlationId } = await loginAndKickEligibility('MRN-AL-5');
    const jwe = await encryptToParticipant(
      {
        resourceType: 'Bundle',
        type: 'collection',
        entry: [{ resource: { resourceType: 'CoverageEligibilityResponse', outcome: 'complete' } }],
      },
      ourPublicKeyPem,
      'v1',
    );
    const res = await request(app.getHttpServer())
      .post('/nhcx/inbound')
      .set('x-hcx-correlation-id', correlationId)
      .set('x-hcx-operation', 'coverageeligibility/on_check')
      .set('x-hcx-sender-code', 'star-health@hcx')
      .send({ payload: jwe, type: 'JWEPayload' });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    // Inactive payer means the allowlist is effectively empty for
    // 'star-health@hcx' AND nothing else is seeded — falls into the
    // default-permit branch. Confirm that explicitly: the row should
    // still be written.
    const inbound = await readInbound(migrator, correlationId);
    expect(inbound).not.toBeNull();
    void tenantId;
  });
});
