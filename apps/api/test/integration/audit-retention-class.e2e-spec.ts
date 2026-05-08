// Slice BO — canary that audit_log.retentionClass is stamped at
// write time by AuditService.recordWithTx + populated by the
// migration's backfill on legacy rows.
//
//   1. Service write of USER_LOGGED_IN → row.retentionClass = 'session'.
//   2. USER_FAILED_LOGIN → 'security'.
//   3. DOCTOR_SIGNED → 'clinical'.
//   4. USER_INVITED → 'governance'.
//   5. Unknown action (raw insert with custom action) gets the
//      'financial' default applied by the column DEFAULT clause.
//   6. Migration backfill canary: the column DEFAULT clause +
//      legacy-row backfill SQL means a fresh DB has no NULLs and
//      no rows with empty `retentionClass`.

import { generateKeyPairSync } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import cookieParser from 'cookie-parser';

import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { AuditEvents } from '../../src/modules/audit/audit.events';
import { AuditService } from '../../src/modules/audit/audit.service';
import { startPostgres, type PgHandles } from '../setup/postgres-container';

jest.setTimeout(180_000);

describe('Slice BO — audit_log retentionClass', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;
  let audit: AuditService;
  let tenantId: string;

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

    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      const t = await tx.tenant.create({
        data: {
          slug: 'tenant-bo-retention',
          displayName: 'BO Retention Hospital',
          lifecycleState: 'IN_SETUP',
        },
      });
      tenantId = t.id;
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.use(cookieParser());
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();
    audit = app.get(AuditService);
  });

  afterAll(async () => {
    await app?.close();
    await migrator.$disconnect().catch(() => undefined);
    await pg.shutdown();
  });

  async function readRetentionClass(action: string): Promise<string> {
    const rows = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      return tx.$queryRaw<Array<{ retentionClass: string }>>(
        Prisma.sql`SELECT "retentionClass" FROM "audit_log" WHERE "tenantId" = ${tenantId}::uuid AND "action" = ${action} ORDER BY "occurredAt" DESC LIMIT 1`,
      );
    });
    return rows[0]?.retentionClass ?? '';
  }

  it.each([
    [AuditEvents.USER_LOGGED_IN, 'session'],
    [AuditEvents.USER_FAILED_LOGIN, 'security'],
    [AuditEvents.DOCTOR_SIGNED, 'clinical'],
    [AuditEvents.USER_INVITED, 'governance'],
  ] as const)('AuditService.record(%s) stamps retentionClass=%s', async (action, expected) => {
    await audit.record({
      tenantId,
      actorUserId: null,
      actorType: 'system',
      action,
      resourceType: 'user',
    });
    expect(await readRetentionClass(action)).toBe(expected);
  });

  it('column DEFAULT clause applies financial when raw INSERT skips the column (legacy / unknown actions)', async () => {
    // Simulate a legacy or unmapped audit write that bypasses the TS
    // classifier — the column DEFAULT 'financial' must still kick in.
    const customAction = `LEGACY_UNMAPPED_${Date.now()}`;
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "audit_log" ("id", "tenantId", "actorType", "action", "resourceType")
        VALUES (gen_random_uuid(), ${tenantId}::uuid, 'system', ${customAction}, 'user')
      `);
    });
    expect(await readRetentionClass(customAction)).toBe('financial');
  });

  it('every audit_log row in a fresh DB has a non-empty retentionClass (post-migration invariant)', async () => {
    const rows = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      return tx.$queryRaw<Array<{ count: bigint }>>(
        Prisma.sql`SELECT COUNT(*)::bigint AS count FROM "audit_log" WHERE "retentionClass" IS NULL OR "retentionClass" = ''`,
      );
    });
    expect(Number(rows[0]?.count ?? 0n)).toBe(0);
  });
});
