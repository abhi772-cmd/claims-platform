// Slice BC integration test — gateway-pushed PaymentNotice drives the
// claim from PAYMENT_PENDING → PAYMENT_RECEIVED automatically.
//
// Drive a claim through to PAYMENT_PENDING (the existing pattern from
// the remittance-batch suite), look up the claim/on_submit outbound
// row's correlationId, then POST a PaymentNotice JWE on that same
// correlationId. The dispatcher resolves tenant + claim from the
// matching outbound and calls SettlementService.recordReceipt with
// actorUserId=null.

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

async function readClaim(
  prisma: PrismaClient,
  claimId: string,
): Promise<{ status: string; paidAmount: number | null } | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
    );
    return tx.claim.findUnique({
      where: { id: claimId },
      select: { status: true, paidAmount: true },
    });
  });
}

async function readSettlement(
  prisma: PrismaClient,
  claimId: string,
): Promise<{
  receivedAmount: number | null;
  bankTxnId: string | null;
  reconciliationStatus: string;
} | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
    );
    return tx.settlement.findUnique({
      where: { claimId },
      select: { receivedAmount: true, bankTxnId: true, reconciliationStatus: true },
    });
  });
}

async function findClaimSubmitOutboundCorrelation(
  prisma: PrismaClient,
  claimId: string,
): Promise<string> {
  const row = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
    );
    return tx.integrationMessage.findFirst({
      where: { claimId, direction: 'outbound', operation: 'claim.submit' },
      orderBy: { createdAt: 'desc' },
      select: { correlationId: true },
    });
  });
  if (!row) throw new Error('no claim.submit outbound row found');
  return row.correlationId;
}

async function waitForInboundStatus(
  prisma: PrismaClient,
  correlationId: string,
  ceilingMs = 10_000,
): Promise<{ status: string; failureClass: string | null }> {
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
          operation: 'paymentnotice/request',
        },
        select: { status: true, failureClass: true },
      });
    });
    if (row && row.status !== 'pending') return row;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `paymentnotice inbound row for correlationId=${correlationId} did not leave status=pending within ${ceilingMs}ms`,
  );
}

function buildPaymentNoticeBundle(opts: {
  receivedAmount: number;
  paymentDate: string;
  bankTxnId: string;
  claimRefNum: string;
}): Record<string, unknown> {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      {
        resource: {
          resourceType: 'PaymentNotice',
          status: 'active',
          amount: { value: opts.receivedAmount, currency: 'INR' },
          paymentDate: opts.paymentDate,
          identifier: [{ system: 'bank', value: opts.bankTxnId }],
          request: { reference: `Claim/${opts.claimRefNum}` },
        },
      },
    ],
  };
}

describe('Slice BC — paymentnotice/request inbound', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN = 'admin-pn@pn-test.local';
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
        data: { slug: 'tenant-pn', displayName: 'Payment Notice', lifecycleState: 'IN_SETUP' },
      });
      const adminRole = await tx.role.create({
        data: {
          tenantId: tenant.id,
          name: 'tenant_admin',
          permissions: [
            'case.create',
            'case.view',
            'case.assign',
            'preauth.draft',
            'preauth.submit',
            'preauth.approve_internal',
            'claim.draft',
            'claim.submit',
            'settlement.upload_eob',
          ],
        },
      });
      const a = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: ADMIN,
          passwordHash,
          firstName: 'PN',
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

  // Drive a fresh case to PAYMENT_PENDING — same recipe as the
  // remittance-batch suite, condensed.
  async function caseAtPaymentPending(
    cookies: string[],
    mrn: string,
    finalAmount: number,
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
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/transitions`)
      .set('Cookie', cookies)
      .send({ eventType: 'preauth.drafting_started' });
    await request(app.getHttpServer())
      .put(`/cases/${caseId}/claims/${claimId}/preauth/draft`)
      .set('Cookie', cookies)
      .send({
        diagnosisDescription: 'Acute MI',
        plannedProcedure: 'CABG',
        requestedAmount: finalAmount,
      });
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/submit`)
      .set('Cookie', cookies)
      .send({});
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/decision`)
      .set('Cookie', cookies)
      .send({ kind: 'approved', approvedAmount: finalAmount });
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/discharge/initiate`)
      .set('Cookie', cookies)
      .send({});
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/documents/upload-stub`)
      .set('Cookie', cookies)
      .send({
        documentType: 'discharge_summary',
        originalFilename: 'd.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1024,
      });
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/discharge/submit`)
      .set('Cookie', cookies)
      .send({});
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/claim-submission/start`)
      .set('Cookie', cookies)
      .send({});
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/claim-submission/submit`)
      .set('Cookie', cookies)
      .send({ finalAmount });
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/claim-submission/decision`)
      .set('Cookie', cookies)
      .send({ kind: 'approved', approvedAmount: finalAmount });
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/settlement/expect`)
      .set('Cookie', cookies)
      .send({ paymentMode: 'cashless_tpa' });
    return { caseId, claimId };
  }

  it('drives PAYMENT_PENDING → PAYMENT_RECEIVED + persists bankTxnId', async () => {
    const cookies = await loginAs(ADMIN);
    const { claimId } = await caseAtPaymentPending(cookies, 'MRN-PN-1', 100_000);

    // The orchestrator wrote a claim.submit outbound under this
    // correlationId — the gateway echoes the same id when it pushes
    // a PaymentNotice.
    const correlationId = await findClaimSubmitOutboundCorrelation(migrator, claimId);

    const jwe = await encryptToParticipant(
      buildPaymentNoticeBundle({
        receivedAmount: 100_000,
        paymentDate: '2026-05-08T10:30:00Z',
        bankTxnId: 'BANK-PN-9001',
        claimRefNum: 'STUB-CL-12345',
      }),
      ourPublicKeyPem,
      'v1',
    );
    const res = await request(app.getHttpServer())
      .post('/nhcx/inbound')
      .set('x-hcx-correlation-id', correlationId)
      .set('x-hcx-operation', 'paymentnotice/request')
      .set('x-hcx-sender-code', 'star-health@hcx')
      .send({ payload: jwe, type: 'JWEPayload' });
    expect(res.status).toBe(202);

    const out = await waitForInboundStatus(migrator, correlationId);
    expect(out.status).toBe('succeeded');

    const claim = await readClaim(migrator, claimId);
    expect(claim?.status).toBe('PAYMENT_RECEIVED');
    expect(claim?.paidAmount).toBe(100_000);

    const settlement = await readSettlement(migrator, claimId);
    expect(settlement?.receivedAmount).toBe(100_000);
    expect(settlement?.bankTxnId).toBe('BANK-PN-9001');
    expect(settlement?.reconciliationStatus).toBe('manual_match_pending');
  });

  it('short-paid PaymentNotice drives PAYMENT_PENDING → SHORT_PAID', async () => {
    const cookies = await loginAs(ADMIN);
    const { claimId } = await caseAtPaymentPending(cookies, 'MRN-PN-2', 200_000);
    const correlationId = await findClaimSubmitOutboundCorrelation(migrator, claimId);

    const jwe = await encryptToParticipant(
      buildPaymentNoticeBundle({
        receivedAmount: 150_000,
        paymentDate: '2026-05-08T10:30:00Z',
        bankTxnId: 'BANK-PN-9002',
        claimRefNum: 'STUB-CL-67890',
      }),
      ourPublicKeyPem,
      'v1',
    );
    const res = await request(app.getHttpServer())
      .post('/nhcx/inbound')
      .set('x-hcx-correlation-id', correlationId)
      .set('x-hcx-operation', 'paymentnotice/request')
      .set('x-hcx-sender-code', 'star-health@hcx')
      .send({ payload: jwe, type: 'JWEPayload' });
    expect(res.status).toBe(202);

    const out = await waitForInboundStatus(migrator, correlationId);
    expect(out.status).toBe('succeeded');

    const claim = await readClaim(migrator, claimId);
    expect(claim?.status).toBe('SHORT_PAID');
    expect(claim?.paidAmount).toBe(150_000);

    const settlement = await readSettlement(migrator, claimId);
    expect(settlement?.reconciliationStatus).toBe('short_paid');
    expect(settlement?.bankTxnId).toBe('BANK-PN-9002');
  });

  it('cancelled PaymentNotice is recorded but does not drive a transition', async () => {
    const cookies = await loginAs(ADMIN);
    const { claimId } = await caseAtPaymentPending(cookies, 'MRN-PN-3', 75_000);
    const correlationId = randomUUID();

    // Manually create a matching outbound row so the receive() path
    // accepts this — without it the inbound is "invalid".
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const claim = await tx.claim.findUniqueOrThrow({
        where: { id: claimId },
        select: { tenantId: true },
      });
      await tx.integrationMessage.create({
        data: {
          tenantId: claim.tenantId,
          claimId,
          direction: 'outbound',
          integration: 'nhcx',
          operation: 'claim.submit',
          correlationId,
          status: 'succeeded',
        },
      });
    });

    const jwe = await encryptToParticipant(
      {
        resourceType: 'Bundle',
        type: 'collection',
        entry: [
          {
            resource: {
              resourceType: 'PaymentNotice',
              status: 'cancelled',
              amount: { value: 0, currency: 'INR' },
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
      .set('x-hcx-operation', 'paymentnotice/request')
      .set('x-hcx-sender-code', 'star-health@hcx')
      .send({ payload: jwe, type: 'JWEPayload' });
    expect(res.status).toBe(202);

    const out = await waitForInboundStatus(migrator, correlationId);
    expect(out.status).toBe('succeeded');

    // Claim stays at PAYMENT_PENDING — no transition was driven.
    const claim = await readClaim(migrator, claimId);
    expect(claim?.status).toBe('PAYMENT_PENDING');
  });
});
