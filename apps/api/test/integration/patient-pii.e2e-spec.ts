// Slice R integration test — encrypted patient PII end-to-end.
//
//   1. POST /cases with a patient block creates a Patient row + links it
//      to the Case.
//   2. The DB row stores ciphertext, NOT plaintext (no Aadhaar / mobile
//      visible in the raw column).
//   3. PatientService.getDecrypted round-trips back to the original.
//   4. lookupHash columns let us find the patient by Aadhaar without
//      scanning ciphertext.
//   5. Cases without a patient block (legacy flow) still succeed and
//      have patientId = null.

import { generateKeyPairSync, randomBytes } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { argon2id, hash } from 'argon2';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { PatientService } from '../../src/modules/patient';
import { lookupHash } from '../../src/modules/patient/pii.crypto';
import { startPostgres, type PgHandles } from '../setup/postgres-container';

jest.setTimeout(180_000);

describe('Slice R — encrypted patient PII', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;
  let patientService: PatientService;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN = 'admin-pii@pii-test.local';

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
    process.env['NOTIFICATION_RETRY_DISABLED'] = 'true';
    process.env['PII_KMS_MODE'] = 'stub';
    process.env['PII_KMS_ROOT_KEY_BASE64'] = randomBytes(32).toString('base64');

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const tenant = await tx.tenant.create({
        data: { slug: 'tenant-pii', displayName: 'PII', lifecycleState: 'IN_SETUP' },
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
          firstName: 'PII',
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
    patientService = app.get(PatientService);
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

  it('POST /cases with patient block creates encrypted Patient row + links Case', async () => {
    const cookies = await loginAs(ADMIN);
    const r = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'Asha Devi',
        hospitalMrn: 'MRN-PII-1',
        admissionDate: '2026-05-01',
        admissionType: 'planned',
        primaryRail: 'pmjay',
        patient: {
          aadhaar: '123412341234',
          mobile: '+919812345678',
          email: 'asha@example.com',
          dateOfBirth: '1985-03-12',
          gender: 'female',
          policyNumber: 'POL-9001',
        },
      });
    expect(r.status).toBeLessThan(400);
    const caseId = r.body.id as string;

    // Look up the raw Patient row via the migrator client (bypasses RLS
    // tenant gating since we run with platform_admin GUC) and assert the
    // ciphertext columns hold opaque base64 with the original value
    // nowhere to be found.
    const row = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const c = await tx.case.findUnique({ where: { id: caseId } });
      if (!c?.patientId) throw new Error('case missing patientId');
      return tx.patient.findUnique({ where: { id: c.patientId } });
    });
    expect(row).not.toBeNull();
    expect(row!.aadhaarCipher).not.toBeNull();
    expect(row!.aadhaarCipher).not.toContain('123412341234');
    expect(row!.mobileCipher).not.toContain('9812345678');
    expect(row!.emailCipher).not.toContain('asha@example.com');
    // Lookup hashes are deterministic SHA-256.
    expect(row!.aadhaarHash).toBe(lookupHash('123412341234'));
    expect(row!.mobileHash).toBe(lookupHash('+919812345678'));
    // Plaintext display fields stay readable.
    expect(row!.fullName).toBe('Asha Devi');
    expect(row!.dateOfBirth).not.toBeNull();
  });

  it('PatientService.getDecrypted round-trips back to the original values', async () => {
    const cookies = await loginAs(ADMIN);
    const r = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'Rohan Singh',
        hospitalMrn: 'MRN-PII-2',
        admissionDate: '2026-05-02',
        admissionType: 'emergency',
        primaryRail: 'nhcx',
        patient: {
          aadhaar: '999988887777',
          mobile: '+919900000001',
        },
      });
    const caseId = r.body.id as string;

    // Resolve patientId from the case row (using the migrator with
    // platform_admin so we don't need a session cookie for this lookup).
    const patientId = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const c = await tx.case.findUnique({ where: { id: caseId } });
      return c?.patientId ?? null;
    });
    expect(patientId).not.toBeNull();

    // Resolve tenantId for the service call.
    const tenantId = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const c = await tx.case.findUnique({ where: { id: caseId } });
      return c!.tenantId;
    });

    const decrypted = await patientService.getDecrypted(tenantId, patientId!);
    expect(decrypted).not.toBeNull();
    expect(decrypted!.aadhaar).toBe('999988887777');
    expect(decrypted!.mobile).toBe('+919900000001');
    expect(decrypted!.fullName).toBe('Rohan Singh');
  });

  it('PatientService.findByLookup matches by Aadhaar hash', async () => {
    const cookies = await loginAs(ADMIN);
    await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'Lookup Patient',
        hospitalMrn: 'MRN-PII-3',
        admissionDate: '2026-05-03',
        admissionType: 'planned',
        primaryRail: 'pmjay',
        patient: { aadhaar: '111122223333' },
      });
    const tenantId = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const t = await tx.tenant.findUnique({ where: { slug: 'tenant-pii' } });
      return t!.id;
    });
    const found = await patientService.findByLookup(tenantId, { aadhaar: '111122223333' });
    expect(found).not.toBeNull();
    const miss = await patientService.findByLookup(tenantId, { aadhaar: '000000000000' });
    expect(miss).toBeNull();
  });

  it('legacy POST /cases without a patient block still works (patientId is null)', async () => {
    const cookies = await loginAs(ADMIN);
    const r = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'No PII',
        hospitalMrn: 'MRN-PII-4',
        admissionDate: '2026-05-04',
        admissionType: 'planned',
        primaryRail: 'self_pay',
      });
    expect(r.status).toBeLessThan(400);
    const caseId = r.body.id as string;
    const c = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      return tx.case.findUnique({ where: { id: caseId } });
    });
    expect(c).not.toBeNull();
    expect(c!.patientId).toBeNull();
  });
});
