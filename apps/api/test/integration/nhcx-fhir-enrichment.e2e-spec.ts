// Slice AA integration test — FHIR R4 enrichment lands on every NHCX
// outbound. Slice T wired the JWE adapter to materialise FHIR Bundles
// when patient + coverage are supplied; Slice AA threads those fields
// from the orchestrator services so the four phases (preauth, discharge,
// claim-submit, communication) all reach the adapter with the enriched
// input. The stub adapter echoes the input back as rawRequest so we
// can assert the wiring without a live gateway.
//
//   1. Eligibility submit stamps payerCode on the claim row.
//   2. Preauth submit's outbound rawRequest carries patient + coverage
//      + diagnosis fields.
//   3. Discharge submit's outbound rawRequest carries patient + coverage.
//   4. Claim submit's outbound rawRequest carries patient + coverage +
//      clinical fields + document ids.
//   5. Preauth respond-to-query's outbound rawRequest carries patient +
//      coverage + inReplyToRefNum.
//   6. Legacy case (no Patient row, no payerCode at eligibility):
//      coverage is undefined; the adapter falls back to lightweight payload.

import { generateKeyPairSync, randomBytes } from 'node:crypto';

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

async function readOutboundRequest(
  prisma: PrismaClient,
  correlationId: string,
): Promise<Record<string, unknown> | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
    );
    const row = await tx.integrationMessage.findFirst({
      where: { correlationId, direction: 'outbound', integration: 'nhcx' },
      select: { rawRequest: true },
    });
    return (row?.rawRequest as Record<string, unknown>) ?? null;
  });
}

async function readClaim(
  prisma: PrismaClient,
  claimId: string,
): Promise<{ payerCode: string | null; preauthRefNum: string | null } | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
    );
    return tx.claim.findUnique({
      where: { id: claimId },
      select: { payerCode: true, preauthRefNum: true },
    });
  });
}

describe('Slice AA — FHIR enrichment threads through every NHCX outbound', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN = 'admin-fhirenr@fhirenr-test.local';

  beforeAll(async () => {
    pg = await startPostgres();
    migrator = new PrismaClient({ datasources: { db: { url: pg.migratorUrl } } });

    const jwt = generateKeyPairSync('rsa', { modulusLength: 2048 });
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
    // PII KMS — give the test a deterministic 32-byte root key so
    // PatientService can encrypt + decrypt as part of the case-create
    // path.
    process.env['PII_KMS_ROOT_KEY_BASE64'] = randomBytes(32).toString('base64');

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const tenant = await tx.tenant.create({
        data: { slug: 'tenant-fhirenr', displayName: 'FHIR Enr', lifecycleState: 'IN_SETUP' },
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
            'preauth.respond_query',
            'preauth.approve_internal',
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
          firstName: 'FHIR',
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

  // Drive a case through eligibility + preauth submit, returning the
  // ids + the preauth correlationId for assertion lookups.
  async function caseToPreauthSubmitted(mrn: string): Promise<{
    caseId: string;
    claimId: string;
    preauthCorrelationId: string;
  }> {
    const cookies = await loginAs(ADMIN);
    const caseRes = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'Asha Devi',
        hospitalMrn: mrn,
        admissionDate: '2026-05-01',
        admissionType: 'planned',
        primaryRail: 'nhcx',
        // Slice R PII enrichment — encrypts on insert so subsequent
        // FHIR bundles can carry abhaId / policyNumber.
        patient: {
          fullName: 'Asha Devi',
          dateOfBirth: '1980-04-12',
          gender: 'female',
          abhaId: '1234567890123456',
          policyNumber: 'POL-001',
          mobile: '+919876543210',
        },
      });
    expect(caseRes.status).toBe(201);
    const caseId = caseRes.body.id as string;
    const claimId = caseRes.body.claims[0].id as string;

    const elig = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/eligibility`)
      .set('Cookie', cookies)
      .send({ payerCode: 'star-health@hcx', policyNumber: 'POL-001' });
    expect(elig.status).toBe(200);

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
        diagnosisDescription: 'Acute myocardial infarction',
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
    return {
      caseId,
      claimId,
      preauthCorrelationId: submit.body.correlationId as string,
    };
  }

  it('eligibility stamps payerCode on the claim', async () => {
    const cookies = await loginAs(ADMIN);
    const caseRes = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'Patient X',
        hospitalMrn: 'MRN-AA-PC',
        admissionDate: '2026-05-01',
        admissionType: 'planned',
        primaryRail: 'nhcx',
      });
    expect(caseRes.status).toBe(201);
    const caseId = caseRes.body.id as string;
    const claimId = caseRes.body.claims[0].id as string;

    const eligNoPayer = await readClaim(migrator, claimId);
    expect(eligNoPayer!.payerCode).toBeNull();

    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/eligibility`)
      .set('Cookie', cookies)
      .send({ payerCode: 'star-health@hcx' });

    const eligWithPayer = await readClaim(migrator, claimId);
    expect(eligWithPayer!.payerCode).toBe('star-health@hcx');
  });

  it('preauth submit propagates patient + coverage + diagnosis to the adapter', async () => {
    const { preauthCorrelationId } = await caseToPreauthSubmitted('MRN-AA-PA');

    const raw = await readOutboundRequest(migrator, preauthCorrelationId);
    expect(raw).not.toBeNull();
    expect(raw!['bundleType']).toBe('Claim');
    expect(raw!['use']).toBe('preauthorization');
    expect(raw!['patient']).toMatchObject({
      fullName: 'Asha Devi',
      hospitalMrn: 'MRN-AA-PA',
      abhaId: '1234567890123456',
      policyNumber: 'POL-001',
      gender: 'female',
    });
    expect(raw!['coverage']).toMatchObject({
      payerCode: 'star-health@hcx',
      memberId: 'POL-001',
    });
    expect(raw!['diagnosisIcdCode']).toBe('I21');
    expect(raw!['plannedProcedure']).toBe('CABG');
    expect(raw!['requestedAmount']).toBe(250_000);
  });

  it('discharge submit propagates patient + coverage + documentIds', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseToPreauthSubmitted('MRN-AA-DI');
    // Approve preauth (admin escape hatch) so we can move to discharge.
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/decision`)
      .set('Cookie', cookies)
      .send({ kind: 'approved', approvedAmount: 250_000 });
    // Upload a discharge_summary doc (stub path).
    const upload = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/documents/upload-stub`)
      .set('Cookie', cookies)
      .send({
        documentType: 'discharge_summary',
        originalFilename: 'discharge.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1024,
      });
    expect(upload.status).toBe(201);
    // Initiate + submit discharge.
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/discharge/initiate`)
      .set('Cookie', cookies)
      .send({});
    const sub = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/discharge/submit`)
      .set('Cookie', cookies)
      .send({});
    expect(sub.status).toBe(200);

    // Discharge correlationId is on the latest outbound row for this claim.
    const correlationId = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const row = await tx.integrationMessage.findFirst({
        where: {
          claimId,
          direction: 'outbound',
          integration: 'nhcx',
          operation: 'discharge.submit',
        },
        select: { correlationId: true },
      });
      return row?.correlationId ?? null;
    });
    expect(correlationId).not.toBeNull();
    const raw = await readOutboundRequest(migrator, correlationId!);
    expect(raw).not.toBeNull();
    expect(raw!['patient']).toMatchObject({ hospitalMrn: 'MRN-AA-DI' });
    expect(raw!['coverage']).toMatchObject({ payerCode: 'star-health@hcx' });
    expect(Array.isArray(raw!['documentIds'])).toBe(true);
    expect((raw!['documentIds'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('claim submit propagates patient + coverage + clinical + documentIds', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseToPreauthSubmitted('MRN-AA-CL');
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/decision`)
      .set('Cookie', cookies)
      .send({ kind: 'approved', approvedAmount: 250_000 });
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
      .post(`/cases/${caseId}/claims/${claimId}/discharge/initiate`)
      .set('Cookie', cookies)
      .send({});
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/discharge/submit`)
      .set('Cookie', cookies)
      .send({});
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/claim-submission/start`)
      .set('Cookie', cookies)
      .send({});
    const submit = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/claim-submission/submit`)
      .set('Cookie', cookies)
      .send({ finalAmount: 248_000 });
    expect(submit.status).toBe(200);
    const claimCorrelationId = submit.body.correlationId as string;
    const raw = await readOutboundRequest(migrator, claimCorrelationId);
    expect(raw).not.toBeNull();
    expect(raw!['bundleType']).toBe('Claim');
    expect(raw!['use']).toBe('claim');
    expect(raw!['patient']).toMatchObject({ hospitalMrn: 'MRN-AA-CL' });
    expect(raw!['coverage']).toMatchObject({ payerCode: 'star-health@hcx' });
    expect(raw!['finalAmount']).toBe(248_000);
    expect(raw!['diagnosisIcdCode']).toBe('I21');
    expect(raw!['plannedProcedure']).toBe('CABG');
    expect(Array.isArray(raw!['documentIds'])).toBe(true);
  });

  it('preauth respond-to-query propagates patient + coverage + inReplyToRefNum', async () => {
    const cookies = await loginAs(ADMIN);
    const { caseId, claimId } = await caseToPreauthSubmitted('MRN-AA-Q');
    // Drive into QUERY_RAISED via the admin escape hatch.
    await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/decision`)
      .set('Cookie', cookies)
      .send({ kind: 'query_received', queryText: 'Need MRI report' });

    const queryRow = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      return tx.preauthQuery.findFirst({
        where: { claimId },
        select: { id: true },
      });
    });
    expect(queryRow).not.toBeNull();

    const respond = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/queries/${queryRow!.id}/respond`)
      .set('Cookie', cookies)
      .send({ responseText: 'MRI attached.' });
    expect(respond.status).toBe(200);

    // Latest outbound for this claim with operation preauth.query.respond.
    const correlationId = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const row = await tx.integrationMessage.findFirst({
        where: {
          claimId,
          direction: 'outbound',
          integration: 'nhcx',
          operation: 'preauth.query.respond',
        },
        select: { correlationId: true },
      });
      return row?.correlationId ?? null;
    });
    expect(correlationId).not.toBeNull();
    const raw = await readOutboundRequest(migrator, correlationId!);
    expect(raw).not.toBeNull();
    expect(raw!['patient']).toMatchObject({ hospitalMrn: 'MRN-AA-Q' });
    expect(raw!['coverage']).toMatchObject({ payerCode: 'star-health@hcx' });
    expect(raw!['responseText']).toBe('MRI attached.');
    // The preauth submit stamped a payerRefNum on the claim; the query
    // response should reference it as inReplyToRefNum.
    const claim = await readClaim(migrator, claimId);
    expect(raw!['inReplyToRefNum']).toBe(claim!.preauthRefNum);
  });

  it('legacy case (no payer code) keeps coverage undefined', async () => {
    const cookies = await loginAs(ADMIN);
    const caseRes = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'Legacy',
        hospitalMrn: 'MRN-AA-LEG',
        admissionDate: '2026-05-01',
        admissionType: 'planned',
        primaryRail: 'nhcx',
      });
    const caseId = caseRes.body.id as string;
    const claimId = caseRes.body.claims[0].id as string;
    // Eligibility WITHOUT payerCode.
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
        diagnosisDescription: 'Routine',
        plannedProcedure: 'X',
        requestedAmount: 1_000,
      });
    const submit = await request(app.getHttpServer())
      .post(`/cases/${caseId}/claims/${claimId}/preauth/submit`)
      .set('Cookie', cookies)
      .send({});
    expect(submit.status).toBe(200);
    const raw = await readOutboundRequest(migrator, submit.body.correlationId as string);
    expect(raw).not.toBeNull();
    expect(raw!['coverage']).toBeUndefined();
    // Patient still populated from case display fields even without
    // a Patient row.
    expect(raw!['patient']).toMatchObject({ hospitalMrn: 'MRN-AA-LEG' });
  });
});
