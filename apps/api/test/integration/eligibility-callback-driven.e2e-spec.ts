// Slice AC integration test — eligibility in NHCX_MODE=real is
// callback-driven: the orchestrator submits + transitions to
// ELIGIBILITY_CHECK_PENDING, and the gateway's webhook callback is
// the only thing that drives the verified/failed transition.
//
// Without this slice (cf. Slice Z's eligibility test), the
// orchestrator auto-transitioned synchronously and the inbound
// dispatcher then hit a duplicate-transition that the row recorded
// as failureClass='state-machine'. With this slice, the inbound
// dispatcher's transition succeeds cleanly and the row is
// 'succeeded'.

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { argon2id, hash } from 'argon2';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import {
  decryptFromParticipant,
  encryptToParticipant,
} from '../../src/modules/nhcx/nhcx.crypto';
import { startPostgres, type PgHandles } from '../setup/postgres-container';

jest.setTimeout(180_000);

interface MockGateway {
  url: string;
  shutdown: () => Promise<void>;
}

// In-process mock NHCX gateway that decrypts the participant's
// outbound JWE with the gateway's private key + responds with a JWE
// envelope that the participant can decrypt. Mirrors Slice P's pattern.
async function startMockGateway(
  gatewayPrivPem: string,
  participantPubPem: string,
): Promise<MockGateway> {
  const server: Server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      // P0.3 — outbound body is { payload: <jwe> } JSON envelope.
      const envelopeIn = JSON.parse(body) as { payload: string };
      await decryptFromParticipant(envelopeIn.payload, gatewayPrivPem);
      const responseBundle = { meta: { acknowledged: true }, payload: { acknowledged: true } };
      const encrypted = await encryptToParticipant(responseBundle, participantPubPem);
      // P0.3 — wrap response in JSON envelope too.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ payload: encrypted }));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    shutdown: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function readClaimStatus(
  prisma: PrismaClient,
  claimId: string,
): Promise<string | null> {
  const row = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
    );
    return tx.claim.findUnique({
      where: { id: claimId },
      select: { status: true },
    });
  });
  return row?.status ?? null;
}

async function readInboundStatus(
  prisma: PrismaClient,
  correlationId: string,
): Promise<{ status: string; failureClass: string | null } | null> {
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
      select: { status: true, failureClass: true },
    });
  });
}

describe('Slice AC — eligibility callback-driven in real mode', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;
  let mockGateway: MockGateway | undefined;

  // Two RSA keypairs:
  //   "us" = the participant (claims-platform); we own these.
  //   "gw" = the gateway (NHCX); we mock it locally.
  let usKeys: { pubPem: string; privPem: string };
  let gwKeys: { pubPem: string; privPem: string };

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN = 'admin-eligcb@eligcb-test.local';

  beforeAll(async () => {
    pg = await startPostgres();
    migrator = new PrismaClient({ datasources: { db: { url: pg.migratorUrl } } });

    const jwt = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const us = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const gw = generateKeyPairSync('rsa', { modulusLength: 2048 });
    usKeys = {
      pubPem: us.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privPem: us.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };
    gwKeys = {
      pubPem: gw.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privPem: gw.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };

    mockGateway = await startMockGateway(gwKeys.privPem, usKeys.pubPem);

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
    process.env['PII_KMS_ROOT_KEY_BASE64'] = randomBytes(32).toString('base64');

    // Real-mode NHCX wired to the mock gateway.
    process.env['NHCX_MODE'] = 'real';
    process.env['NHCX_GATEWAY_URL'] = mockGateway.url;
    process.env['NHCX_PARTICIPANT_CODE'] = 'PARTICIPANT_TEST';
    process.env['NHCX_PRIVATE_KEY_BASE64'] = Buffer.from(usKeys.privPem).toString('base64');
    process.env['NHCX_GATEWAY_PUBLIC_KEY_BASE64'] = Buffer.from(gwKeys.pubPem).toString('base64');
    process.env['NHCX_PRIVATE_KEY_VERSION'] = 'v1';

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const tenant = await tx.tenant.create({
        data: { slug: 'tenant-eligcb', displayName: 'Elig CB', lifecycleState: 'IN_SETUP' },
      });
      const role = await tx.role.create({
        data: {
          tenantId: tenant.id,
          name: 'tenant_admin',
          permissions: ['case.create', 'case.view', 'case.assign'],
        },
      });
      const u = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: ADMIN,
          passwordHash,
          firstName: 'CB',
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
  });

  afterAll(async () => {
    await app?.close();
    await migrator.$disconnect().catch(() => undefined);
    await pg?.shutdown();
    if (mockGateway) await mockGateway.shutdown();
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

  it('eligibility submit → claim PENDING; webhook → claim VERIFIED, no state-machine error', async () => {
    const cookies = await loginAs(ADMIN);
    const caseRes = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'Callback Patient',
        hospitalMrn: 'MRN-CB-1',
        admissionDate: '2026-05-01',
        admissionType: 'planned',
        primaryRail: 'nhcx',
      });
    expect(caseRes.status).toBe(201);
    const caseId = caseRes.body.id as string;
    const claimId = caseRes.body.claims[0].id as string;

    const elig = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/eligibility`)
      .set('Cookie', cookies)
      .send({ payerCode: 'star-health@hcx', policyNumber: 'POL-1' });
    expect(elig.status).toBe(200);
    // Real-mode contract: orchestrator returns the pending status,
    // verified=false, with a correlationId we can match the callback to.
    expect(elig.body.verified).toBe(false);
    expect(elig.body.status).toBe('ELIGIBILITY_CHECK_PENDING');
    expect(elig.body.correlationId).toMatch(/^[a-f0-9-]{36}$/);

    // No auto-transition fired. Confirm via direct DB read.
    expect(await readClaimStatus(migrator, claimId)).toBe('ELIGIBILITY_CHECK_PENDING');

    // Now fire the gateway webhook with a CoverageEligibilityResponse
    // JWE-encrypted to OUR public key (the gateway encrypts inbound to
    // the participant's pubkey).
    const bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [
        {
          resource: {
            resourceType: 'CoverageEligibilityResponse',
            outcome: 'complete',
            disposition: 'Eligible',
            insurance: [
              {
                coverage: { display: 'Star Health Gold' },
                item: [{ benefit: [{ allowedMoney: { value: 500_000 } }] }],
              },
            ],
          },
        },
      ],
    };
    const jwe = await encryptToParticipant(bundle, usKeys.pubPem, 'v1');
    const inbound = await request(app.getHttpServer())
      .post('/nhcx/inbound')
      .set('x-hcx-correlation-id', elig.body.correlationId)
      .set('x-hcx-operation', 'coverageeligibility/on_check')
      .set('x-hcx-sender-code', 'star-health@hcx')
      .send({ payload: jwe, type: 'JWEPayload' });
    expect(inbound.status).toBe(200);

    // Wait for the fire-and-forget process() to complete.
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      const row = await readInboundStatus(migrator, elig.body.correlationId);
      if (row && row.status !== 'pending') break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const row = await readInboundStatus(migrator, elig.body.correlationId);
    expect(row).not.toBeNull();
    // Slice AC's promise: clean transition, no state-machine error.
    expect(row!.status).toBe('succeeded');
    expect(row!.failureClass).toBeNull();

    // And the claim is now VERIFIED.
    expect(await readClaimStatus(migrator, claimId)).toBe('ELIGIBILITY_VERIFIED');
  });
});
