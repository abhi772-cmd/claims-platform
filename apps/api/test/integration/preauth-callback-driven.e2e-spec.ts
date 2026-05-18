// Slice AD integration test — preauth in NHCX_MODE=real is callback-
// driven. The orchestrator transitions DRAFTING → QUEUED and stops;
// the gateway's preauth/on_submit callback drives QUEUED → SUBMITTED
// → APPROVED in PreauthService.handleInboundResponse.

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

// In-process mock NHCX gateway. Synchronous response carries
// {acknowledged, payerRefNum} so the JWE adapter's submitPreauth
// returns a payerRefNum the orchestrator can echo back to the caller.
async function startMockGateway(
  gatewayPrivPem: string,
  participantPubPem: string,
  payerRefNum: string,
): Promise<MockGateway> {
  const server: Server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      // P0.3 — outbound body is { payload: <jwe> } JSON envelope.
      const envelopeIn = JSON.parse(body) as { payload: string };
      await decryptFromParticipant(envelopeIn.payload, gatewayPrivPem);
      const responseBundle = {
        meta: { acknowledged: true },
        payload: { acknowledged: true, payerRefNum },
      };
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

async function readClaim(
  prisma: PrismaClient,
  claimId: string,
): Promise<{ status: string; approvedAmount: number | null; payerRefNum: string | null } | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
    );
    return tx.claim.findUnique({
      where: { id: claimId },
      select: { status: true, approvedAmount: true, payerRefNum: true },
    });
  });
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
        operation: 'preauth/on_submit',
      },
      select: { status: true, failureClass: true },
    });
  });
}

describe('Slice AD — preauth callback-driven in real mode', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;
  let mockGateway: MockGateway | undefined;

  let usKeys: { pubPem: string; privPem: string };
  let gwKeys: { pubPem: string; privPem: string };

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN = 'admin-pacb@pacb-test.local';
  const PAYER_REF = 'STAR-PR-1234';

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

    mockGateway = await startMockGateway(gwKeys.privPem, usKeys.pubPem, PAYER_REF);

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
        data: { slug: 'tenant-pacb', displayName: 'PA CB', lifecycleState: 'IN_SETUP' },
      });
      const role = await tx.role.create({
        data: {
          tenantId: tenant.id,
          name: 'tenant_admin',
          permissions: [
            'case.create',
            'case.view',
            'case.assign',
            'preauth.draft',
            'preauth.submit',
          ],
        },
      });
      const u = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: ADMIN,
          passwordHash,
          firstName: 'PA',
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

  it('preauth submit → QUEUED; preauth/on_submit callback → APPROVED, no state-machine error', async () => {
    const cookies = await loginAs(ADMIN);

    // Walk a fresh case through eligibility (real-mode, so eligibility
    // sits at PENDING — drive it to VERIFIED via the gateway callback).
    const caseRes = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'PA Patient',
        hospitalMrn: 'MRN-PACB-1',
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
    expect(elig.body.status).toBe('ELIGIBILITY_CHECK_PENDING');

    // Drive eligibility to VERIFIED via the gateway callback.
    const eligBundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [
        {
          resource: {
            resourceType: 'CoverageEligibilityResponse',
            outcome: 'complete',
            disposition: 'Eligible',
          },
        },
      ],
    };
    const eligJwe = await encryptToParticipant(eligBundle, usKeys.pubPem, 'v1');
    await request(app.getHttpServer())
      .post('/nhcx/inbound')
      .set('x-hcx-correlation-id', elig.body.correlationId)
      .set('x-hcx-operation', 'coverageeligibility/on_check')
      .send({ payload: eligJwe, type: 'JWEPayload' });

    // Wait for the eligibility callback to settle.
    const eligStart = Date.now();
    while (Date.now() - eligStart < 10_000) {
      const c = await readClaim(migrator, claimId);
      if (c?.status === 'ELIGIBILITY_VERIFIED') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect((await readClaim(migrator, claimId))?.status).toBe('ELIGIBILITY_VERIFIED');

    // Manual transition to PREAUTH_DRAFTING (Sprint 2 has no auto-advance).
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/transitions`)
      .set('Cookie', cookies)
      .send({ eventType: 'preauth.drafting_started' });

    await request(app.getHttpServer())
      .put(`/cases/${caseId}/claims/${claimId}/preauth/draft`)
      .set('Cookie', cookies)
      .send({
        diagnosisIcdCode: 'I21',
        diagnosisDescription: 'Acute MI',
        plannedProcedure: 'CABG',
        procedureCode: '00.66',
        estimatedLengthOfStayDays: 5,
        requestedAmount: 250_000,
        clinicalJustification: 'Bypass surgery indicated.',
      });

    // Submit. In real mode the orchestrator stops at QUEUED.
    const submit = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/submit`)
      .set('Cookie', cookies)
      .send({});
    expect(submit.status).toBe(200);
    expect(submit.body.status).toBe('PREAUTH_QUEUED');
    expect(submit.body.payerRefNum).toBe(PAYER_REF);
    const correlationId = submit.body.correlationId as string;

    // Direct DB confirms — no auto-transition.
    const afterSubmit = await readClaim(migrator, claimId);
    expect(afterSubmit?.status).toBe('PREAUTH_QUEUED');
    expect(afterSubmit?.payerRefNum).toBeNull(); // not stamped yet — gateway does it on ack

    // Now fire the gateway's on_submit callback with an "approved" decision.
    const decisionBundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [
        {
          resource: {
            resourceType: 'ClaimResponse',
            outcome: 'complete',
            disposition: 'Approved',
            total: [
              {
                category: { coding: [{ code: 'benefit' }] },
                amount: { value: 240_000, currency: 'INR' },
              },
            ],
          },
        },
      ],
    };
    const decisionJwe = await encryptToParticipant(decisionBundle, usKeys.pubPem, 'v1');
    const inbound = await request(app.getHttpServer())
      .post('/nhcx/inbound')
      .set('x-hcx-correlation-id', correlationId)
      .set('x-hcx-operation', 'preauth/on_submit')
      .send({ payload: decisionJwe, type: 'JWEPayload' });
    expect(inbound.status).toBe(200);

    // Wait for the inbound process() to settle.
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      const row = await readInboundStatus(migrator, correlationId);
      if (row && row.status !== 'pending') break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const inboundRow = await readInboundStatus(migrator, correlationId);
    expect(inboundRow?.status).toBe('succeeded');
    expect(inboundRow?.failureClass).toBeNull();

    // Two-step transition completed: QUEUED → SUBMITTED → APPROVED.
    const final = await readClaim(migrator, claimId);
    expect(final?.status).toBe('PREAUTH_APPROVED');
    expect(final?.approvedAmount).toBe(240_000);
  });
});
