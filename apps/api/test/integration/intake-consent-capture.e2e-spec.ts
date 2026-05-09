// Slice CF — intake-flow consent capture e2e canary.
//
//   1. POST /cases with patient + consent atomically writes case +
//      patient + consent record + audit rows for both case-create
//      and consent-grant.
//   2. Back-compat: POST /cases without `patient` + `consent` still
//      creates a case (Sprint 2 walking-skeleton path).
//   3. Mismatch: POST /cases with `consent` but no `patient` → 422
//      (consent has nothing to bind to).
//   4. ConsentService.findActiveFor finds the just-granted consent
//      using the new patientId, and the consentType matches what
//      the form derived from the primary rail.

import { generateKeyPairSync } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { argon2id, hash } from 'argon2';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ConsentService } from '../../src/modules/consent/consent.service';
import { startPostgres, type PgHandles } from '../setup/postgres-container';

jest.setTimeout(180_000);

describe('Slice CF — intake-flow consent capture', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;
  let consents: ConsentService;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN = 'admin-cf@cf-test.local';
  let tenantId = '';

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
      const t = await tx.tenant.create({
        data: { slug: 'tenant-cf', displayName: 'CF', lifecycleState: 'IN_SETUP' },
      });
      tenantId = t.id;
      const role = await tx.role.create({
        data: {
          tenantId: t.id,
          name: 'tenant_admin',
          permissions: ['case.create', 'case.view'],
        },
      });
      const u = await tx.user.create({
        data: {
          tenantId: t.id,
          email: ADMIN,
          passwordHash,
          firstName: 'CF',
          lastName: 'Admin',
          status: 'active',
        },
      });
      await tx.userRole.create({
        data: { tenantId: t.id, userId: u.id, roleId: role.id },
      });
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.use(cookieParser());
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();
    consents = app.get(ConsentService);
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

  const validConsent = {
    consentType: 'nhcx_processing',
    dataCategories: ['aadhaar', 'mobile'],
    purposes: ['eligibility.verify', 'preauth.submit', 'claim.submit'],
    lawfulBasis: 'consent',
    source: 'in_person_signature',
    evidence: {
      noticeText: 'You authorise the hospital to share your data with NHCX participants.',
      acknowledgedVia: 'in_person_signature',
      locales: ['en-IN'],
    },
  };

  it('POST /cases with patient + consent commits all three atomically', async () => {
    const cookies = await loginAs(ADMIN);
    const res = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'CF Patient One',
        hospitalMrn: 'MRN-CF-0001',
        admissionDate: '2026-05-09',
        admissionType: 'planned',
        primaryRail: 'nhcx',
        patient: {
          aadhaar: '123456789012',
          mobile: '+919876543210',
        },
        consent: validConsent,
      });
    expect(res.status).toBe(201);

    const caseId = res.body.id as string;
    expect(caseId).toBeDefined();

    // Pull the case row + patient + consent under platform_admin.
    const state = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      const c = await tx.case.findUniqueOrThrow({
        where: { id: caseId },
        select: { id: true, patientId: true, tenantId: true },
      });
      const consent = await tx.consentRecord.findFirst({
        where: { tenantId, patientId: c.patientId! },
      });
      const audits = await tx.auditLog.findMany({
        where: {
          tenantId,
          OR: [
            { resourceType: 'case', resourceId: caseId },
            { resourceType: 'consent_record' },
          ],
        },
        select: { action: true, resourceType: true },
      });
      return { caseRow: c, consent, audits };
    });

    expect(state.caseRow.patientId).not.toBeNull();
    expect(state.consent).not.toBeNull();
    expect(state.consent!.consentType).toBe('nhcx_processing');
    expect(state.consent!.status).toBe('granted');
    expect(state.consent!.lawfulBasis).toBe('consent');

    // Both audit rows present in the same tenant.
    const actions = state.audits.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['CONSENT_GRANTED']));

    // findActiveFor finds the just-granted consent.
    const active = await consents.findActiveFor(
      tenantId,
      state.caseRow.patientId!,
      'nhcx_processing',
    );
    expect(active).not.toBeNull();
    expect(active!.id).toBe(state.consent!.id);
  });

  it('back-compat: POST /cases without patient + consent still creates a case', async () => {
    const cookies = await loginAs(ADMIN);
    const res = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'CF Patient Two',
        hospitalMrn: 'MRN-CF-0002',
        admissionDate: '2026-05-09',
        admissionType: 'emergency',
        primaryRail: 'self_pay',
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
  });

  it('rejects consent block when no patient block accompanies it (422)', async () => {
    const cookies = await loginAs(ADMIN);
    const res = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'CF Patient Three',
        hospitalMrn: 'MRN-CF-0003',
        admissionDate: '2026-05-09',
        admissionType: 'planned',
        primaryRail: 'nhcx',
        // patient block omitted on purpose
        consent: validConsent,
      });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/patient PII/i);
  });

  it('PMJAY rail captures pmjay_processing consent type', async () => {
    const cookies = await loginAs(ADMIN);
    const res = await request(app.getHttpServer())
      .post('/cases')
      .set('Cookie', cookies)
      .send({
        patientName: 'CF Patient Four',
        hospitalMrn: 'MRN-CF-0004',
        admissionDate: '2026-05-09',
        admissionType: 'planned',
        primaryRail: 'pmjay',
        patient: { aadhaar: '987654321098' },
        consent: { ...validConsent, consentType: 'pmjay_processing' },
      });
    expect(res.status).toBe(201);

    const caseId = res.body.id as string;
    const state = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      const c = await tx.case.findUniqueOrThrow({
        where: { id: caseId },
        select: { patientId: true },
      });
      const consent = await tx.consentRecord.findFirst({
        where: { tenantId, patientId: c.patientId! },
      });
      return { consent };
    });
    expect(state.consent!.consentType).toBe('pmjay_processing');
  });
});
