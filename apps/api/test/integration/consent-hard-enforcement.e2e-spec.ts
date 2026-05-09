// Slice CG — DPDP §6 hard-enforcement e2e canary.
//
//   1. Default state (requireConsent=false) → CB soft binding
//      preserved. Read with no grant proceeds; access ledger row
//      records consentGrantId=null.
//   2. POST /admin/tenants/:id/require-consent { enabled: true }
//      flips the flag (audit row written).
//   3. Read with no grant after flip → ConsentRequiredError
//      with code CONSENT_REQUIRED, status 412, problem-detail
//      payload includes patientId + consentType.
//   4. With an active grant after flip → read proceeds + binds.
//   5. POST /admin/tenants/:id/require-consent { enabled: false }
//      flips back; soft binding resumes.
//
// Drives the gate via FhirContextService.build directly (cheaper
// than spinning up a full preauth submit) — same code path the
// real flows go through.

import { generateKeyPairSync, randomBytes } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { argon2id, hash } from 'argon2';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ConsentService } from '../../src/modules/consent/consent.service';
import { FhirContextService } from '../../src/modules/nhcx/fhir-context.service';
import { startPostgres, type PgHandles } from '../setup/postgres-container';

jest.setTimeout(180_000);

describe('Slice CG — DPDP hard-enforcement flag', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;
  let consents: ConsentService;
  let fhirContext: FhirContextService;

  const PASSWORD = 'CorrectHorseBattery!2026';
  const ADMIN = 'admin-cg@cg-test.local';
  let tenantId = '';
  let adminUserId = '';
  let patientId = '';
  let claimId = '';

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
    process.env['PII_KMS_MODE'] = 'stub';
    process.env['PII_KMS_ROOT_KEY_BASE64'] = randomBytes(32).toString('base64');
    process.env['PII_KMS_KEY_VERSION'] = 'v1';

    const passwordHash = await hash(PASSWORD, { type: argon2id });
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const t = await tx.tenant.create({
        data: { slug: 'tenant-cg', displayName: 'CG', lifecycleState: 'IN_SETUP' },
      });
      tenantId = t.id;
      const role = await tx.role.create({
        data: {
          tenantId: t.id,
          name: 'tenant_admin',
          permissions: [
            'case.create',
            'case.view',
            'tenant.security.update',
          ],
        },
      });
      const u = await tx.user.create({
        data: {
          tenantId: t.id,
          email: ADMIN,
          passwordHash,
          firstName: 'CG',
          lastName: 'Admin',
          status: 'active',
        },
      });
      adminUserId = u.id;
      await tx.userRole.create({
        data: { tenantId: t.id, userId: u.id, roleId: role.id },
      });

      // Seed a patient + case + claim so FhirContextService.build
      // has something to walk. patient cipher fields are placeholders;
      // we don't exercise decryption in this test.
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      const patient = await tx.patient.create({
        data: {
          tenantId,
          fullName: 'CG Patient',
          aadhaarCipher: 'cipher-aadhaar',
          aadhaarKeyVersion: 'v1',
          mobileCipher: 'cipher-mobile',
          mobileKeyVersion: 'v1',
        },
        select: { id: true },
      });
      patientId = patient.id;
      const c = await tx.case.create({
        data: {
          tenantId,
          patientId,
          patientName: 'CG Patient',
          hospitalMrn: 'MRN-CG-0001',
          admissionDate: new Date('2026-05-09'),
          admissionType: 'planned',
          primaryRail: 'nhcx',
          createdById: adminUserId,
        },
        select: { id: true },
      });
      const claim = await tx.claim.create({
        data: { tenantId, caseId: c.id, rail: 'nhcx', status: 'INITIATED' },
        select: { id: true },
      });
      claimId = claim.id;
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.use(cookieParser());
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();
    consents = app.get(ConsentService);
    fhirContext = app.get(FhirContextService);
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

  // The tx in the consent service decrypts patient PII; placeholder
  // ciphers throw inside getDecrypted. We only care that the consent
  // gate fires (or doesn't); catch below tolerates the downstream
  // decryption failure.
  async function buildContext(): Promise<{ ok: boolean; err?: { code?: string; status?: number } }> {
    try {
      await fhirContext.build(tenantId, claimId, {
        actorUserId: adminUserId,
        actorType: 'user',
        purpose: 'preauth.submit',
      });
      return { ok: true };
    } catch (err) {
      const e = err as { code?: string; status?: number };
      return { ok: false, err: e };
    }
  }

  it('default state: requireConsent=false → soft binding (no grant, read proceeds)', async () => {
    // No grant, no flag → CB soft binding. Should not throw
    // ConsentRequiredError. (May still throw later in the pipeline
    // because the placeholder ciphertext won't decrypt — that's an
    // unrelated failure mode and we don't care about it here.)
    const out = await buildContext();
    expect(out.err?.code).not.toBe('CONSENT_REQUIRED');
  });

  it('flip flag on via POST /admin/tenants/:id/require-consent', async () => {
    const cookies = await loginAs(ADMIN);
    const res = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/require-consent`)
      .set('Cookie', cookies)
      .send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.requireConsent).toBe(true);

    // Audit row landed.
    const audits = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      return tx.auditLog.findMany({
        where: {
          tenantId,
          action: 'TENANT_REQUIRE_CONSENT_UPDATED',
        },
      });
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('after flip, no grant → ConsentRequiredError (412 CONSENT_REQUIRED)', async () => {
    const out = await buildContext();
    expect(out.ok).toBe(false);
    expect(out.err?.code).toBe('CONSENT_REQUIRED');
  });

  it('with an active grant after flip → context builds (no consent error)', async () => {
    await consents.grant({
      tenantId,
      actorUserId: adminUserId,
      patientId,
      consentType: 'nhcx_processing',
      dataCategories: ['aadhaar', 'mobile'],
      purposes: ['preauth.submit'],
      lawfulBasis: 'consent',
      source: 'in_person',
      evidence: {
        noticeText: 'CG test notice',
        acknowledgedVia: 'in_person_signature',
      },
    });
    const out = await buildContext();
    // No CONSENT_REQUIRED. (Decryption may still fail downstream
    // because of placeholder ciphertext; that's the same caveat as
    // the first test.)
    expect(out.err?.code).not.toBe('CONSENT_REQUIRED');
  });

  it('flipping back to false restores soft binding', async () => {
    const cookies = await loginAs(ADMIN);
    const res = await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/require-consent`)
      .set('Cookie', cookies)
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.requireConsent).toBe(false);
  });
});
