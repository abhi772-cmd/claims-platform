// Slice BD integration test — auxiliary HCX 0.7.1 inbound message
// types (`insuranceplan/on_request`, `task/on_submit`). These don't
// drive state transitions; the slice's contract is "accepted, parsed,
// recorded on the integration_message ledger, no claim status change".
//
// Pattern mirrors the BC paymentnotice suite: drive a claim part-way
// through the pipeline so a matching outbound exists, then POST the
// JWE'd inbound on that correlationId.

import { generateKeyPairSync } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { argon2id, hash } from 'argon2';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { encryptToParticipant } from '../../src/modules/nhcx/nhcx.crypto';
import { startPostgres, type PgHandles } from '../setup/postgres-container';

jest.setTimeout(180_000);

async function readClaimStatus(
  prisma: PrismaClient,
  claimId: string,
): Promise<string | null> {
  const row = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
    );
    return tx.claim.findUnique({ where: { id: claimId }, select: { status: true } });
  });
  return row?.status ?? null;
}

async function findEligibilityOutboundCorrelation(
  prisma: PrismaClient,
  claimId: string,
): Promise<string> {
  const row = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
    );
    return tx.integrationMessage.findFirst({
      where: { claimId, direction: 'outbound', operation: 'eligibility.verify' },
      orderBy: { createdAt: 'desc' },
      select: { correlationId: true },
    });
  });
  if (!row) throw new Error('no eligibility.verify outbound row found');
  return row.correlationId;
}

async function waitForInboundStatus(
  prisma: PrismaClient,
  correlationId: string,
  operation: string,
  ceilingMs = 10_000,
): Promise<{ status: string }> {
  const start = Date.now();
  while (Date.now() - start < ceilingMs) {
    const row = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      return tx.integrationMessage.findFirst({
        where: {
          correlationId,
          direction: 'inbound',
          integration: 'nhcx',
          operation,
        },
        select: { status: true },
      });
    });
    if (row && row.status !== 'pending') return row;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `inbound row for correlationId=${correlationId} operation=${operation} did not leave pending`,
  );
}

describe('Slice BD — auxiliary inbound messages (insuranceplan + task)', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN = 'admin-aux@aux-test.local';
  let ourPublicKeyPem: string;

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
        data: { slug: 'tenant-aux', displayName: 'Auxiliary', lifecycleState: 'IN_SETUP' },
      });
      const adminRole = await tx.role.create({
        data: {
          tenantId: tenant.id,
          name: 'tenant_admin',
          permissions: ['case.create', 'case.view', 'case.assign'],
        },
      });
      const a = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: ADMIN,
          passwordHash,
          firstName: 'AUX',
          lastName: 'Admin',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tenant.id, userId: a.id, roleId: adminRole.id },
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

  // Drive a fresh case through eligibility so a matching outbound row
  // exists. The auxiliary message types don't have their own outbound
  // — they piggy-back on whatever phase correlationId the gateway
  // chooses to use, so reusing the eligibility correlation is fine.
  async function caseAtEligibility(
    cookies: string[],
    mrn: string,
  ): Promise<{ caseId: string; claimId: string }> {
    const create = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'Patient',
        hospitalMrn: mrn,
        admissionDate: '2026-05-01',
        admissionType: 'planned',
        primaryRail: 'nhcx',
      });
    const caseId = create.body.id as string;
    const claimId = create.body.claims[0].id as string;
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/eligibility`)
      .set('Cookie', cookies)
      .send({});
    return { caseId, claimId };
  }

  it('insuranceplan/on_request: recorded as succeeded with parsed summary, no transition', async () => {
    const cookies = await loginAs(ADMIN);
    const { claimId } = await caseAtEligibility(cookies, 'MRN-AUX-1');
    const correlationId = await findEligibilityOutboundCorrelation(migrator, claimId);
    const statusBefore = await readClaimStatus(migrator, claimId);

    const jwe = await encryptToParticipant(
      {
        resourceType: 'Bundle',
        type: 'collection',
        entry: [
          {
            resource: {
              resourceType: 'InsurancePlan',
              identifier: [{ system: 'plan', value: 'STAR-GOLD-2026' }],
              name: 'Star Health Gold 2026',
              status: 'active',
              type: [{ coding: [{ code: 'medical' }] }],
            },
          },
        ],
      },
      ourPublicKeyPem,
      'v1',
    );
    const res = await request(app.getHttpServer())
      .post('/nhcx/inbound')
      .set('x-hcx-correlation-id', correlationId)
      .set('x-hcx-operation', 'insuranceplan/on_request')
      .set('x-hcx-sender-code', 'star-health@hcx')
      .send({ payload: jwe, type: 'JWEPayload' });
    expect(res.status).toBe(200);

    const out = await waitForInboundStatus(migrator, correlationId, 'insuranceplan/on_request');
    expect(out.status).toBe('succeeded');

    const statusAfter = await readClaimStatus(migrator, claimId);
    expect(statusAfter).toBe(statusBefore);
  });

  it('task/on_submit: recorded as succeeded with parsed summary, no transition', async () => {
    const cookies = await loginAs(ADMIN);
    const { claimId } = await caseAtEligibility(cookies, 'MRN-AUX-2');
    const correlationId = await findEligibilityOutboundCorrelation(migrator, claimId);
    const statusBefore = await readClaimStatus(migrator, claimId);

    const jwe = await encryptToParticipant(
      {
        resourceType: 'Bundle',
        type: 'collection',
        entry: [
          {
            resource: {
              resourceType: 'Task',
              status: 'requested',
              description: 'Please re-upload the discharge summary',
              focus: { reference: 'Claim/STUB-CL-12345' },
            },
          },
        ],
      },
      ourPublicKeyPem,
      'v1',
    );
    const res = await request(app.getHttpServer())
      .post('/nhcx/inbound')
      .set('x-hcx-correlation-id', correlationId)
      .set('x-hcx-operation', 'task/on_submit')
      .set('x-hcx-sender-code', 'star-health@hcx')
      .send({ payload: jwe, type: 'JWEPayload' });
    expect(res.status).toBe(200);

    const out = await waitForInboundStatus(migrator, correlationId, 'task/on_submit');
    expect(out.status).toBe('succeeded');

    const statusAfter = await readClaimStatus(migrator, claimId);
    expect(statusAfter).toBe(statusBefore);
  });
});
