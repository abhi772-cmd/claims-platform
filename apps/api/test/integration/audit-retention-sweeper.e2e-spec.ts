// Slice BP — retention sweeper e2e canary.
//
//   1. Seed rows of each class with `occurredAt` past their floor +
//      a recent row in each class. After sweepAll(): the past-floor
//      rows are gone, the recent rows survive.
//   2. Per-class delete counts in the result match the seeded
//      past-floor row counts.
//   3. The self-audit row (action=AUDIT_RETENTION_SWEEP_COMPLETED)
//      is written with retentionClass='governance' and the per-class
//      counts in the JSON `after` field.
//   4. Calling the Postgres function without first flipping
//      `app.role` to 'retention_sweeper' deletes nothing (RLS
//      policy gate works as designed). This protects against an
//      accidental sweep from a misconfigured caller.

import { generateKeyPairSync } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import cookieParser from 'cookie-parser';

import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { AuditRetentionSweeperService } from '../../src/modules/audit/audit-retention-sweeper.service';
import { startPostgres, type PgHandles } from '../setup/postgres-container';

jest.setTimeout(180_000);

describe('Slice BP — audit retention sweeper', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;
  let sweeper: AuditRetentionSweeperService;
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
          slug: 'tenant-bp-sweep',
          displayName: 'BP Sweep',
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
    sweeper = app.get(AuditRetentionSweeperService);
  });

  afterAll(async () => {
    await app?.close();
    await migrator.$disconnect().catch(() => undefined);
    await pg.shutdown();
  });

  // Seed an audit_log row directly with a chosen occurredAt. Bypasses
  // the service so we can plant rows in the past without faking the
  // clock. The platform_admin role is allowed by the existing
  // audit_log_insert policy.
  async function seedRow(
    action: string,
    retentionClass: string,
    daysAgo: number,
  ): Promise<void> {
    await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "audit_log"
          ("id", "tenantId", "occurredAt", "actorType", "action", "resourceType", "retentionClass")
        VALUES (
          gen_random_uuid(),
          ${tenantId}::uuid,
          now() - make_interval(days => ${daysAgo}::int),
          'system',
          ${action},
          'user',
          ${retentionClass}
        )
      `);
    });
  }

  async function countRows(retentionClass: string): Promise<number> {
    const rows = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      return tx.$queryRaw<Array<{ c: bigint }>>(
        Prisma.sql`SELECT COUNT(*)::bigint AS c FROM "audit_log" WHERE "retentionClass" = ${retentionClass}`,
      );
    });
    return Number(rows[0]?.c ?? 0n);
  }

  it('sweepAll deletes past-floor rows per class and preserves recent rows', async () => {
    // Two past-floor rows + one recent row in each class.
    // session: floor 90d → seed 95d ago + 89d ago.
    // security: floor 1095d → seed 1100d + 1090d.
    // clinical: floor 1825d → seed 1830d + 1820d.
    // governance: floor 2920d → seed 2925d + 2915d.
    // consent: floor 2920d → seed 2925d + 2915d.
    // financial: floor 3650d → seed 3700d + 3640d.
    const seedSet: Array<[string, number, number]> = [
      ['session', 95, 89],
      ['security', 1100, 1090],
      ['clinical', 1830, 1820],
      ['governance', 2925, 2915],
      ['consent', 2925, 2915],
      ['financial', 3700, 3640],
    ];
    for (const [cls, oldDays, recentDays] of seedSet) {
      await seedRow('TEST_PAST', cls, oldDays);
      await seedRow('TEST_RECENT', cls, recentDays);
    }

    const r = await sweeper.sweepAll();
    expect(r.totalDeleted).toBe(seedSet.length);
    for (const [cls] of seedSet) {
      expect(r.counts[cls as keyof typeof r.counts]).toBe(1);
    }

    // Recent rows survive — counts should still be 1 per class for
    // the recent rows we seeded. Plus 1 extra governance row (the
    // self-audit emitted by sweepAll itself).
    expect(await countRows('session')).toBe(1);
    expect(await countRows('security')).toBe(1);
    expect(await countRows('clinical')).toBe(1);
    expect(await countRows('governance')).toBe(2); // 1 recent + 1 self-audit
    expect(await countRows('consent')).toBe(1);
    expect(await countRows('financial')).toBe(1);
  });

  it('emits a governance-class self-audit row capturing per-class counts', async () => {
    // Seed one extra past-floor session row, sweep, and assert the
    // self-audit row's `after` JSON reflects the latest sweep.
    await seedRow('TEST_PAST_2', 'session', 95);
    const before = await countRows('governance');
    const r = await sweeper.sweepAll();
    const after = await countRows('governance');
    expect(after).toBe(before + 1);

    const rows = await migrator.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      return tx.$queryRaw<Array<{ action: string; after: unknown; retentionClass: string }>>(
        Prisma.sql`SELECT "action", "after", "retentionClass"
                   FROM "audit_log"
                   WHERE "action" = 'AUDIT_RETENTION_SWEEP_COMPLETED'
                   ORDER BY "occurredAt" DESC LIMIT 1`,
      );
    });
    expect(rows[0]).toBeDefined();
    expect(rows[0]!.retentionClass).toBe('governance');
    const payload = rows[0]!.after as {
      counts: Record<string, number>;
      totalDeleted: number;
    };
    expect(payload.totalDeleted).toBe(r.totalDeleted);
    expect(payload.counts.session).toBe(r.counts.session);
  });

  it('audit_retention_sweep() called outside retention_sweeper role deletes 0 rows', async () => {
    // RLS canary: even if a future caller fails to flip the role,
    // the policy denies the DELETE silently — sweep returns 0.
    await seedRow('TEST_PAST_RLS', 'session', 95);
    const before = await countRows('session');

    const rows = await migrator.$transaction(async (tx) => {
      // Note the deliberate-wrong role: platform_admin can SELECT but
      // cannot DELETE from audit_log.
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`);
      return tx.$queryRaw<Array<{ deleted: number }>>(
        Prisma.sql`SELECT audit_retention_sweep('session', 90) AS deleted`,
      );
    });
    expect(Number(rows[0]?.deleted ?? 0)).toBe(0);
    expect(await countRows('session')).toBe(before);
  });

  it('audit_retention_sweep() rejects bad inputs', async () => {
    await expect(
      migrator.$transaction(async (tx) => {
        await tx.$executeRaw(
          Prisma.sql`SELECT set_config('app.role', ${'retention_sweeper'}, true)`,
        );
        await tx.$queryRaw(Prisma.sql`SELECT audit_retention_sweep('session', 0)`);
      }),
    ).rejects.toThrow(/p_floor_days must be > 0/);

    await expect(
      migrator.$transaction(async (tx) => {
        await tx.$executeRaw(
          Prisma.sql`SELECT set_config('app.role', ${'retention_sweeper'}, true)`,
        );
        await tx.$queryRaw(Prisma.sql`SELECT audit_retention_sweep('', 90)`);
      }),
    ).rejects.toThrow(/p_class must be non-empty/);
  });
});
