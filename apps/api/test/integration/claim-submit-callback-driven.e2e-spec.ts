// Slice AE integration test — claim submit in NHCX_MODE=real is
// callback-driven. The orchestrator transitions CLAIM_DRAFTING →
// CLAIM_QUEUED and stops; the gateway's claim/on_submit callback
// drives CLAIM_QUEUED → CLAIM_SUBMITTED → CLAIM_APPROVED via
// ClaimSubmitService.handleInboundResponse.

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

// In-process mock NHCX gateway. Each operation gets its own ref num
// so we can disambiguate which call set which field on the claim.
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
      const decrypted = await decryptFromParticipant<{ meta: { operation: string } }>(
        envelopeIn.payload,
        gatewayPrivPem,
      );
      const op = decrypted.meta?.operation ?? '';
      const payload =
        op === 'preauth/submit'
          ? { acknowledged: true, payerRefNum: 'PR-MOCK-PA' }
          : op === 'claim/submit'
            ? { acknowledged: true, claimRefNum: 'PR-MOCK-CL' }
            : { acknowledged: true };
      const responseBundle = { meta: { acknowledged: true }, payload };
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
): Promise<{ status: string; approvedAmount: number | null; claimRefNum: string | null } | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
    );
    return tx.claim.findUnique({
      where: { id: claimId },
      select: { status: true, approvedAmount: true, claimRefNum: true },
    });
  });
}

async function readInboundStatus(
  prisma: PrismaClient,
  correlationId: string,
  operation: string,
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
        operation,
      },
      select: { status: true, failureClass: true },
    });
  });
}

async function waitForInbound(
  prisma: PrismaClient,
  correlationId: string,
  operation: string,
  ceilingMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ceilingMs) {
    const row = await readInboundStatus(prisma, correlationId, operation);
    if (row && row.status !== 'pending') return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `inbound row for correlationId=${correlationId} op=${operation} never settled`,
  );
}

describe('Slice AE — claim submit callback-driven in real mode', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;
  let mockGateway: MockGateway | undefined;

  let usKeys: { pubPem: string; privPem: string };
  let gwKeys: { pubPem: string; privPem: string };

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN = 'admin-clcb@clcb-test.local';

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
        data: { slug: 'tenant-clcb', displayName: 'Claim CB', lifecycleState: 'IN_SETUP' },
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
            'claim.draft',
            'claim.submit',
          ],
        },
      });
      const u = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: ADMIN,
          passwordHash,
          firstName: 'CL',
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

  async function fireInbound(
    correlationId: string,
    operation: string,
    bundle: Record<string, unknown>,
  ): Promise<void> {
    const jwe = await encryptToParticipant(bundle, usKeys.pubPem, 'v1');
    const res = await request(app.getHttpServer())
      .post('/nhcx/inbound')
      .set('x-hcx-correlation-id', correlationId)
      .set('x-hcx-operation', operation)
      .send({ payload: jwe, type: 'JWEPayload' });
    expect(res.status).toBe(202);
  }

  it('claim submit → QUEUED; claim/on_submit → APPROVED, no state-machine error', async () => {
    const cookies = await loginAs(ADMIN);

    // 1. Create case + run eligibility (real mode).
    const caseRes = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'CL Patient',
        hospitalMrn: 'MRN-CLCB-1',
        admissionDate: '2026-05-01',
        admissionType: 'planned',
        primaryRail: 'nhcx',
      });
    const caseId = caseRes.body.id as string;
    const claimId = caseRes.body.claims[0].id as string;

    const elig = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/eligibility`)
      .set('Cookie', cookies)
      .send({ payerCode: 'star-health@hcx', policyNumber: 'POL-1' });
    expect(elig.body.status).toBe('ELIGIBILITY_CHECK_PENDING');
    await fireInbound(elig.body.correlationId, 'coverageeligibility/on_check', {
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
    });
    await waitForInbound(migrator, elig.body.correlationId, 'coverageeligibility/on_check');
    expect((await readClaim(migrator, claimId))?.status).toBe('ELIGIBILITY_VERIFIED');

    // 2. Drive into preauth, submit, callback approves.
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
        clinicalJustification: 'Bypass.',
      });
    const paSubmit = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/submit`)
      .set('Cookie', cookies)
      .send({});
    expect(paSubmit.body.status).toBe('PREAUTH_QUEUED');
    await fireInbound(paSubmit.body.correlationId, 'preauth/on_submit', {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [
        {
          resource: {
            resourceType: 'ClaimResponse',
            outcome: 'complete',
            disposition: 'Approved',
            total: [
              { category: { coding: [{ code: 'benefit' }] }, amount: { value: 250_000 } },
            ],
          },
        },
      ],
    });
    await waitForInbound(migrator, paSubmit.body.correlationId, 'preauth/on_submit');
    expect((await readClaim(migrator, claimId))?.status).toBe('PREAUTH_APPROVED');

    // 3. Discharge: post-Slice AF, real mode also stops at PENDING and
    // requires the gateway's communication/request callback to advance
    // to SUBMITTED. Upload the required document, initiate, submit,
    // then fire the inbound to ack.
    const upload = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/documents/upload-stub`)
      .set('Cookie', cookies)
      .send({
        documentType: 'discharge_summary',
        originalFilename: 'd.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1024,
      });
    expect(upload.status).toBe(201);
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/discharge/initiate`)
      .set('Cookie', cookies)
      .send({});
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/discharge/submit`)
      .set('Cookie', cookies)
      .send({});
    // Look up the discharge outbound's correlationId so we can fire
    // the gateway's ack on it.
    const dsCorr = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const r = await tx.integrationMessage.findFirst({
        where: {
          claimId,
          direction: 'outbound',
          integration: 'nhcx',
          operation: 'discharge.submit',
        },
        select: { correlationId: true },
      });
      return r?.correlationId ?? null;
    });
    expect(dsCorr).not.toBeNull();
    {
      const jwe = await encryptToParticipant(
        {
          resourceType: 'Bundle',
          type: 'collection',
          entry: [
            {
              resource: {
                resourceType: 'Communication',
                status: 'completed',
                inResponseTo: [{ reference: 'Communication/discharge' }],
                payload: [{ contentString: 'Discharge acknowledged.' }],
              },
            },
          ],
        },
        usKeys.pubPem,
        'v1',
      );
      const res = await request(app.getHttpServer())
        .post('/nhcx/inbound')
        .set('x-hcx-correlation-id', dsCorr!)
        .set('x-hcx-operation', 'communication/request')
        .send({ payload: jwe, type: 'JWEPayload' });
      expect(res.status).toBe(202);
    }
    await waitForInbound(migrator, dsCorr!, 'communication/request');

    // 4. Claim submit. Slice AE: orchestrator stops at CLAIM_QUEUED.
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/claim-submission/start`)
      .set('Cookie', cookies)
      .send({});
    const submit = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/claim-submission/submit`)
      .set('Cookie', cookies)
      .send({ finalAmount: 240_000 });
    expect(submit.status).toBe(200);
    expect(submit.body.status).toBe('CLAIM_QUEUED');
    expect(submit.body.claimRefNum).toBe('PR-MOCK-CL');
    const correlationId = submit.body.correlationId as string;

    // No auto-transition.
    expect((await readClaim(migrator, claimId))?.status).toBe('CLAIM_QUEUED');

    // 5. Gateway sends claim/on_submit with approved decision.
    await fireInbound(correlationId, 'claim/on_submit', {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [
        {
          resource: {
            resourceType: 'ClaimResponse',
            outcome: 'complete',
            disposition: 'Approved',
            total: [
              { category: { coding: [{ code: 'benefit' }] }, amount: { value: 235_000 } },
            ],
          },
        },
      ],
    });
    await waitForInbound(migrator, correlationId, 'claim/on_submit');

    const inbound = await readInboundStatus(migrator, correlationId, 'claim/on_submit');
    expect(inbound?.status).toBe('succeeded');
    expect(inbound?.failureClass).toBeNull();

    // QUEUED → SUBMITTED → APPROVED in one inbound dispatch.
    const final = await readClaim(migrator, claimId);
    expect(final?.status).toBe('CLAIM_APPROVED');
    expect(final?.approvedAmount).toBe(235_000);
    expect(final?.claimRefNum).toBe('PR-MOCK-CL');
  });
});
