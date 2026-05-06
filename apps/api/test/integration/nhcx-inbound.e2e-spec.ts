// Slice Z integration test — NHCX inbound webhook end to end.
//
//   1. Eligibility callback against an outbound that the stub already
//      transitioned to VERIFIED — the inbound row persists + marks
//      'succeeded'. The eligibility transition is idempotent in the
//      sense that the stub already did it; the inbound dispatcher
//      throws on the duplicate transition, the row records 'failed'
//      with state-machine class, and the test asserts BOTH are
//      acceptable (succeeded OR failed-state-machine). Production
//      always sees the inbound BEFORE the orchestrator transitions —
//      Sprint 4 backlog item to flip the orchestrator to "request +
//      wait for callback" instead of "request + auto-transition".
//
//   2. Preauth callback: real ClaimResponse approved → applyDecision
//      transitions the claim to PREAUTH_APPROVED with approvedAmount
//      stamped, integration_message inbound row marked succeeded.
//
//   3. Idempotency: replaying the same correlationId returns 200 +
//      writes no new inbound row.
//
//   4. Unknown correlationId: 200 + no row written (gateway-side
//      misroute; we don't make NHA retry).
//
//   5. Missing x-hcx-operation header: 422 (client config bug).
//
//   6. Malformed JWE: 200 + row marked 'failed' with failureClass='crypto'.

import { generateKeyPairSync, randomUUID } from 'node:crypto';

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

// Wait for the fire-and-forget process() in NhcxInboundController to
// finish writing back to integration_message. Polls the row's status
// at 50ms cadence with a 5s ceiling.
async function waitForStatusChange(
  prisma: PrismaClient,
  correlationId: string,
  ceilingMs = 5000,
): Promise<{ status: string; failureClass: string | null }> {
  const start = Date.now();
  while (Date.now() - start < ceilingMs) {
    const row = await prisma.integrationMessage.findFirst({
      where: { correlationId, direction: 'inbound', integration: 'nhcx' },
      select: { status: true, failureClass: true },
    });
    if (row && row.status !== 'pending') return row;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `inbound row for correlationId=${correlationId} did not leave status=pending within ${ceilingMs}ms`,
  );
}

function buildEligibilityBundle(verified: boolean): Record<string, unknown> {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      {
        resource: {
          resourceType: 'CoverageEligibilityResponse',
          outcome: verified ? 'complete' : 'error',
          disposition: verified ? 'Eligible' : 'Policy lapsed',
          ...(verified
            ? {
                insurance: [
                  {
                    coverage: { display: 'Star Health Gold' },
                    item: [{ benefit: [{ allowedMoney: { value: 500000 } }] }],
                  },
                ],
              }
            : {}),
        },
      },
    ],
  };
}

function buildPreauthApprovedBundle(approvedAmount: number): Record<string, unknown> {
  return {
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
              amount: { value: approvedAmount, currency: 'INR' },
            },
          ],
        },
      },
    ],
  };
}

describe('Slice Z — NHCX inbound webhook', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN = 'admin-nhcx-in@nhcx-in-test.local';
  let tenantId: string;
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
        data: { slug: 'tenant-nhcx-in', displayName: 'NHCX-In', lifecycleState: 'IN_SETUP' },
      });
      tenantId = tenant.id;
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
          firstName: 'NHCX',
          lastName: 'AdminIn',
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

  async function makeCaseWithEligibility(
    mrn: string,
  ): Promise<{ caseId: string; claimId: string; eligibilityCorrelationId: string }> {
    const cookies = await loginAs(ADMIN);
    const caseRes = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'Inbound Patient',
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
      .set('Cookie', cookies)
      .send({});
    expect(elig.status).toBe(200);
    const eligibilityCorrelationId = elig.body.correlationId as string;
    expect(eligibilityCorrelationId).toBeTruthy();
    return { caseId, claimId, eligibilityCorrelationId };
  }

  it('eligibility callback: persists inbound row + drives processing', async () => {
    const { eligibilityCorrelationId } = await makeCaseWithEligibility('MRN-INB-1');

    const jwe = await encryptToParticipant(
      buildEligibilityBundle(true),
      ourPublicKeyPem,
      'v1',
    );
    const res = await request(app.getHttpServer())
      .post('/nhcx/inbound')
      .set('x-hcx-correlation-id', eligibilityCorrelationId)
      .set('x-hcx-operation', 'coverageeligibility/on_check')
      .set('x-hcx-sender-code', 'star-health@hcx')
      .send({ payload: jwe, type: 'JWEPayload' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');
    expect(res.body.correlationId).toBe(eligibilityCorrelationId);

    // The orchestrator already drove the claim to ELIGIBILITY_VERIFIED
    // synchronously. The inbound dispatcher attempts to transition again
    // with the same event; the state machine refuses the duplicate, and
    // we record 'failed' with state-machine class. This is acceptable
    // for V1 — the row is the audit trail. Sprint 4 backlog: flip the
    // orchestrator so the inbound is the only thing that transitions.
    const out = await waitForStatusChange(migrator, eligibilityCorrelationId);
    expect(['succeeded', 'failed']).toContain(out.status);
    if (out.status === 'failed') {
      expect(out.failureClass).toBe('state-machine');
    }

    const inbound = await migrator.integrationMessage.findFirst({
      where: { correlationId: eligibilityCorrelationId, direction: 'inbound' },
    });
    expect(inbound).not.toBeNull();
    expect(inbound!.operation).toBe('coverageeligibility/on_check');
    expect(inbound!.tenantId).toBe(tenantId);
  });

  it('preauth callback: ClaimResponse approved drives PREAUTH_APPROVED', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await makeCaseWithEligibility('MRN-INB-2');

    // Drive the claim to PREAUTH_DRAFTING then submit so an outbound
    // preauth integration_message exists with a known correlationId.
    const tr = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/transitions`)
      .set('Cookie', cookies)
      .send({ eventType: 'preauth.drafting_started' });
    expect(tr.status).toBe(200);

    const draft = await request(app.getHttpServer())
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
    expect(draft.status).toBe(200);

    const submit = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/submit`)
      .set('Cookie', cookies)
      .send({});
    expect(submit.status).toBe(200);
    expect(submit.body.status).toBe('PREAUTH_SUBMITTED');
    const preauthCorrelationId = submit.body.correlationId as string;
    expect(preauthCorrelationId).toBeTruthy();

    const jwe = await encryptToParticipant(
      buildPreauthApprovedBundle(220000),
      ourPublicKeyPem,
      'v1',
    );
    const res = await request(app.getHttpServer())
      .post('/nhcx/inbound')
      .set('x-hcx-correlation-id', preauthCorrelationId)
      .set('x-hcx-operation', 'preauth/on_submit')
      .set('x-hcx-sender-code', 'star-health@hcx')
      .send({ payload: jwe, type: 'JWEPayload' });
    expect(res.status).toBe(200);

    const out = await waitForStatusChange(migrator, preauthCorrelationId);
    expect(out.status).toBe('succeeded');

    const claim = await migrator.claim.findUnique({ where: { id: claimId } });
    expect(claim).not.toBeNull();
    expect(claim!.status).toBe('PREAUTH_APPROVED');
    expect(claim!.approvedAmount).toBe(220000);
  });

  it('idempotency: repeating the same correlationId is a no-op', async () => {
    const { eligibilityCorrelationId } = await makeCaseWithEligibility('MRN-INB-3');
    const jwe = await encryptToParticipant(
      buildEligibilityBundle(true),
      ourPublicKeyPem,
      'v1',
    );
    const send = (): request.Test =>
      request(app.getHttpServer())
        .post('/nhcx/inbound')
        .set('x-hcx-correlation-id', eligibilityCorrelationId)
        .set('x-hcx-operation', 'coverageeligibility/on_check')
        .send({ payload: jwe, type: 'JWEPayload' });

    const first = await send();
    expect(first.status).toBe(200);
    await waitForStatusChange(migrator, eligibilityCorrelationId);

    const second = await send();
    expect(second.status).toBe(200);

    const rows = await migrator.integrationMessage.findMany({
      where: { correlationId: eligibilityCorrelationId, direction: 'inbound' },
    });
    expect(rows.length).toBe(1);
  });

  it('unknown correlationId: 200 + no row written', async () => {
    const orphanCorrelationId = randomUUID();
    const jwe = await encryptToParticipant(
      buildEligibilityBundle(true),
      ourPublicKeyPem,
      'v1',
    );
    const res = await request(app.getHttpServer())
      .post('/nhcx/inbound')
      .set('x-hcx-correlation-id', orphanCorrelationId)
      .set('x-hcx-operation', 'coverageeligibility/on_check')
      .send({ payload: jwe, type: 'JWEPayload' });
    expect(res.status).toBe(200);
    const rows = await migrator.integrationMessage.findMany({
      where: { correlationId: orphanCorrelationId },
    });
    expect(rows.length).toBe(0);
  });

  it('missing x-hcx-operation header → 422', async () => {
    const { eligibilityCorrelationId } = await makeCaseWithEligibility('MRN-INB-4');
    const jwe = await encryptToParticipant(
      buildEligibilityBundle(true),
      ourPublicKeyPem,
      'v1',
    );
    const res = await request(app.getHttpServer())
      .post('/nhcx/inbound')
      .set('x-hcx-correlation-id', eligibilityCorrelationId)
      .send({ payload: jwe, type: 'JWEPayload' });
    expect(res.status).toBe(422);
  });

  it('malformed JWE: 200 + row marked failed with crypto failureClass', async () => {
    const { eligibilityCorrelationId } = await makeCaseWithEligibility('MRN-INB-5');
    const res = await request(app.getHttpServer())
      .post('/nhcx/inbound')
      .set('x-hcx-correlation-id', eligibilityCorrelationId)
      .set('x-hcx-operation', 'coverageeligibility/on_check')
      .send({ payload: 'not-a-real-jwe.aaa.bbb.ccc.ddd', type: 'JWEPayload' });
    expect(res.status).toBe(200);

    const out = await waitForStatusChange(migrator, eligibilityCorrelationId);
    expect(out.status).toBe('failed');
    expect(out.failureClass).toBe('crypto');
  });
});
