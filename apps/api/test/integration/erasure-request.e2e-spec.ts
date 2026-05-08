// Slice BQ — DPDP §11 erasure-on-request e2e canary.
//
//   1. Reader without erasure.process permission → 403.
//   2. Patient with no claims → 200, status=completed, patient PII
//      redacted (fullName / DOB / gender scrubbed; encrypted ciphers
//      + key versions + lookup hashes nulled), Case.patientName +
//      hospitalMrn replaced with REDACTED-... placeholder. Audit
//      log row written with action=ERASURE_REQUEST_PROCESSED and
//      retentionClass=governance.
//   3. Patient with an active claim (status=PREAUTH_QUEUED) → 200,
//      status=rejected, rejectionReason.blockingClaims lists the
//      claim, no PII redaction performed. Audit row with
//      action=ERASURE_REQUEST_REJECTED.
//   4. Patient with a CLAIM_CLOSED claim → 200, status=completed
//      (closed claims don't block).
//   5. Cross-tenant: tenant A's admin querying tenant B's request
//      id → 422 (RLS canary).
//   6. Unknown patientId → 422.

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

describe('Slice BQ — erasure on request', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN_A = 'admin-bq-a@bq-test.local';
  const READER_A = 'reader-bq-a@bq-test.local';
  const ADMIN_B = 'admin-bq-b@bq-test.local';
  let tenantAId: string;
  let tenantBId: string;

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
    process.env['HPR_STUB_OTP'] = '000000';

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const tA = await tx.tenant.create({
        data: { slug: 'tenant-bq-a', displayName: 'BQ A', lifecycleState: 'IN_SETUP' },
      });
      tenantAId = tA.id;
      const tB = await tx.tenant.create({
        data: { slug: 'tenant-bq-b', displayName: 'BQ B', lifecycleState: 'IN_SETUP' },
      });
      tenantBId = tB.id;
      const adminRole = await tx.role.create({
        data: {
          tenantId: tA.id,
          name: 'tenant_admin',
          permissions: ['case.create', 'case.view', 'case.assign', 'erasure.process'],
        },
      });
      const readerRole = await tx.role.create({
        data: { tenantId: tA.id, name: 'reader', permissions: ['case.view'] },
      });
      const adminRoleB = await tx.role.create({
        data: {
          tenantId: tB.id,
          name: 'tenant_admin',
          permissions: ['case.create', 'case.view', 'case.assign', 'erasure.process'],
        },
      });
      const ua = await tx.user.create({
        data: {
          tenantId: tA.id, email: ADMIN_A, passwordHash,
          firstName: 'A', lastName: 'Admin', status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tA.id, userId: ua.id, roleId: adminRole.id },
      });
      const ur = await tx.user.create({
        data: {
          tenantId: tA.id, email: READER_A, passwordHash,
          firstName: 'A', lastName: 'Reader', status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tA.id, userId: ur.id, roleId: readerRole.id },
      });
      const ub = await tx.user.create({
        data: {
          tenantId: tB.id, email: ADMIN_B, passwordHash,
          firstName: 'B', lastName: 'Admin', status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: tB.id, userId: ub.id, roleId: adminRoleB.id },
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

  async function seedPatient(
    tenantId: string,
    name: string,
    encryptedCiphers = true,
  ): Promise<string> {
    return migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      const p = await tx.patient.create({
        data: {
          tenantId,
          fullName: name,
          dateOfBirth: new Date('1990-01-01'),
          gender: 'male',
          ...(encryptedCiphers
            ? {
                aadhaarCipher: 'b64-cipher-aadhaar',
                aadhaarKeyVersion: 'v1',
                abhaIdCipher: 'b64-cipher-abha',
                abhaIdKeyVersion: 'v1',
                mobileCipher: 'b64-cipher-mobile',
                mobileKeyVersion: 'v1',
                emailCipher: 'b64-cipher-email',
                emailKeyVersion: 'v1',
                aadhaarHash: 'a'.repeat(64),
                mobileHash: 'b'.repeat(64),
              }
            : {}),
        },
        select: { id: true },
      });
      return p.id;
    });
  }

  async function seedCaseWithClaim(
    tenantId: string,
    patientId: string,
    mrn: string,
    claimStatus: string,
    actorUserId: string,
  ): Promise<{ caseId: string; claimId: string }> {
    return migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      const c = await tx.case.create({
        data: {
          tenantId,
          patientId,
          patientName: 'Seed Patient',
          hospitalMrn: mrn,
          admissionDate: new Date('2026-05-01'),
          admissionType: 'planned',
          primaryRail: 'nhcx',
          createdById: actorUserId,
        },
        select: { id: true },
      });
      const cl = await tx.claim.create({
        data: { tenantId, caseId: c.id, rail: 'nhcx', status: claimStatus },
        select: { id: true },
      });
      return { caseId: c.id, claimId: cl.id };
    });
  }

  async function readPatient(tenantId: string, id: string): Promise<{
    fullName: string;
    dateOfBirth: Date | null;
    gender: string | null;
    aadhaarCipher: string | null;
    aadhaarHash: string | null;
    mobileCipher: string | null;
    mobileKeyVersion: string | null;
  } | null> {
    return migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      return tx.patient.findUnique({
        where: { id },
        select: {
          fullName: true,
          dateOfBirth: true,
          gender: true,
          aadhaarCipher: true,
          aadhaarHash: true,
          mobileCipher: true,
          mobileKeyVersion: true,
        },
      });
    });
  }

  async function readCase(tenantId: string, id: string): Promise<{
    patientName: string;
    hospitalMrn: string;
  } | null> {
    return migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      return tx.case.findUnique({
        where: { id },
        select: { patientName: true, hospitalMrn: true },
      });
    });
  }

  it('reader without erasure.process permission → 403', async () => {
    const cookies = await loginAs(READER_A);
    const patientId = await seedPatient(tenantAId, 'Reader Patient');
    const r = await request(app.getHttpServer())
      .post('/erasure-requests')
      .set('Cookie', cookies)
      .send({ patientId, requestedBy: 'Reader Test' });
    expect(r.status).toBe(403);
  });

  it('patient with no claims → completed; PII fields scrubbed', async () => {
    const cookies = await loginAs(ADMIN_A);
    const patientId = await seedPatient(tenantAId, 'No Claims Patient');
    const r = await request(app.getHttpServer())
      .post('/erasure-requests')
      .set('Cookie', cookies)
      .send({ patientId, requestedBy: 'Front desk: ABHA matched 91-XXXX', reason: 'DPDP §11 request' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('completed');
    expect(r.body.affectedCounts).toEqual({ patient: 1, case: 0 });
    expect(r.body.rejectionReason).toBeNull();

    const after = await readPatient(tenantAId, patientId);
    expect(after).not.toBeNull();
    expect(after!.fullName).toMatch(/^REDACTED-/);
    expect(after!.dateOfBirth).toBeNull();
    expect(after!.gender).toBeNull();
    expect(after!.aadhaarCipher).toBeNull();
    expect(after!.aadhaarHash).toBeNull();
    expect(after!.mobileCipher).toBeNull();
    expect(after!.mobileKeyVersion).toBeNull();
  });

  // Read a user.id under platform_admin context — migrator's default
  // session inherits FORCE RLS without the GUC set, so a bare
  // `findUnique({ where: { email } })` returns null even though the
  // row exists.
  async function readUserIdByEmail(email: string): Promise<string> {
    return migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      const u = await tx.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
      return u.id;
    });
  }

  it('patient with active claim → rejected; rejectionReason lists blocking claim; no redaction', async () => {
    const cookies = await loginAs(ADMIN_A);
    const patientId = await seedPatient(tenantAId, 'Active Claim Patient');
    const adminId = await readUserIdByEmail(ADMIN_A);
    const { caseId, claimId } = await seedCaseWithClaim(
      tenantAId,
      patientId,
      'MRN-BQ-ACTIVE',
      'PREAUTH_QUEUED',
      adminId,
    );

    const r = await request(app.getHttpServer())
      .post('/erasure-requests')
      .set('Cookie', cookies)
      .send({ patientId, requestedBy: 'Front desk' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('rejected');
    expect(r.body.affectedCounts).toBeNull();
    expect(r.body.rejectionReason.blockingClaims).toEqual([
      { id: claimId, status: 'PREAUTH_QUEUED' },
    ]);

    // Patient + case unchanged.
    const patientAfter = await readPatient(tenantAId, patientId);
    expect(patientAfter!.fullName).toBe('Active Claim Patient');
    expect(patientAfter!.aadhaarCipher).toBe('b64-cipher-aadhaar');
    const caseAfter = await readCase(tenantAId, caseId);
    expect(caseAfter!.hospitalMrn).toBe('MRN-BQ-ACTIVE');
  });

  it('patient with CLOSED claim → completed (closed claims do not block)', async () => {
    const cookies = await loginAs(ADMIN_A);
    const patientId = await seedPatient(tenantAId, 'Closed Claim Patient');
    const adminId = await readUserIdByEmail(ADMIN_A);
    const { caseId } = await seedCaseWithClaim(
      tenantAId,
      patientId,
      'MRN-BQ-CLOSED',
      'CLOSED',
      adminId,
    );

    const r = await request(app.getHttpServer())
      .post('/erasure-requests')
      .set('Cookie', cookies)
      .send({ patientId, requestedBy: 'Front desk' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('completed');
    expect(r.body.affectedCounts.case).toBe(1);

    const caseAfter = await readCase(tenantAId, caseId);
    expect(caseAfter!.patientName).toMatch(/^REDACTED-/);
    expect(caseAfter!.hospitalMrn).toMatch(/^MRN-REDACTED-/);
  });

  it('cross-tenant GET on someone else\'s request id → 422', async () => {
    // Tenant B files a request, tenant A's admin tries to read it.
    const bCookies = await loginAs(ADMIN_B);
    const patientB = await seedPatient(tenantBId, 'B Patient');
    const filed = await request(app.getHttpServer())
      .post('/erasure-requests')
      .set('Cookie', bCookies)
      .send({ patientId: patientB, requestedBy: 'B Front desk' });
    expect(filed.status).toBe(200);

    const aCookies = await loginAs(ADMIN_A);
    const cross = await request(app.getHttpServer())
      .get(`/erasure-requests/${filed.body.id}`)
      .set('Cookie', aCookies);
    expect(cross.status).toBe(422);
  });

  it('unknown patientId → 422', async () => {
    const cookies = await loginAs(ADMIN_A);
    const r = await request(app.getHttpServer())
      .post('/erasure-requests')
      .set('Cookie', cookies)
      .send({ patientId: '00000000-0000-0000-0000-000000000099', requestedBy: 'X' });
    expect(r.status).toBe(422);
    expect(r.body.errors?.patientId?.[0]).toMatch(/not found/i);
  });
});
