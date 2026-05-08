// Slice BP — audit retention sweeper. Iterates the six retention
// classes, calls the `audit_retention_sweep(class, floor_days)`
// Postgres function for each, and returns per-class deletion counts.
//
// The sweep is platform-wide (not tenant-scoped) — we delete rows
// across every tenant in a single pass per class. RLS lets us do
// this because the `audit_log_delete_retention` policy gates DELETE
// on `app.role = 'retention_sweeper'`, which the sweep sets and
// nothing else does.
//
// Triggering: this service has no @Cron decorator. Redis is
// deferred, so a naive in-app interval would race across replicas
// and over-delete. Ops triggers via the CLI script
// (`pnpm --filter @claims/api audit:retention-sweep`) wired to an
// external scheduler (k8s CronJob, cloud cron, or pg_cron).

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditEvents } from './audit.events';
import {
  ALL_RETENTION_CLASSES,
  type RetentionClass,
  RETENTION_FLOOR_DAYS,
} from './retention-classes';
import { PrismaService } from '../../common/prisma/prisma.service';

export type SweepCounts = Readonly<Record<RetentionClass, number>>;

export interface SweepResult {
  // Per-class delete counts.
  counts: SweepCounts;
  // Total across all classes.
  totalDeleted: number;
  // Wall-clock for the sweep in milliseconds. Useful for ops dashboards.
  durationMs: number;
  // ISO-8601 of when the sweep finished. Stamped into the
  // self-audit row so operators can audit when erasure last ran.
  completedAt: string;
}

@Injectable()
export class AuditRetentionSweeperService {
  private readonly log = new Logger(AuditRetentionSweeperService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Sweep every class in a single transaction. Each class call hits
  // the Postgres function which returns a row count; we sum them up
  // for the result. Self-audit row at the end records the operation.
  async sweepAll(): Promise<SweepResult> {
    const start = Date.now();
    const counts: Record<RetentionClass, number> = {
      financial: 0,
      clinical: 0,
      security: 0,
      session: 0,
      governance: 0,
      consent: 0,
    };

    await this.prisma.$transaction(async (tx) => {
      // Flip the role to retention_sweeper so the
      // audit_log_delete_retention policy permits the DELETE. No
      // tenant_id is set — the sweep is platform-wide.
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'retention_sweeper'}, true)`,
      );

      for (const cls of ALL_RETENTION_CLASSES) {
        const days = RETENTION_FLOOR_DAYS[cls];
        // Cast to INT explicitly — Prisma templates JS numbers as
        // bigint, but `audit_retention_sweep(TEXT, INTEGER)` expects
        // a 4-byte int. Without the cast Postgres errors with
        // "function audit_retention_sweep(text, bigint) does not exist".
        const rows = await tx.$queryRaw<Array<{ deleted: number }>>(
          Prisma.sql`SELECT audit_retention_sweep(${cls}, ${days}::int) AS deleted`,
        );
        counts[cls] = Number(rows[0]?.deleted ?? 0);
      }
    });

    const totalDeleted = Object.values(counts).reduce((sum, n) => sum + n, 0);
    const durationMs = Date.now() - start;
    const completedAt = new Date().toISOString();
    this.log.log(
      `audit retention sweep complete totalDeleted=${totalDeleted} durationMs=${durationMs} ${Object.entries(counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')}`,
    );

    // Self-document: write a governance-class audit row capturing
    // what just happened. This survives the next sweep (governance
    // retention is 8y) so compliance auditors can see when data
    // was last erased and how much. The row is platform-scoped
    // (tenantId is set to a sentinel zero-uuid because audit_log
    // requires a tenantId; future Slice BR ledger could capture
    // platform-scoped events better).
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.role', ${'platform_admin'}, true)`,
      );
      // Use the zero UUID for tenantId — sentinel meaning "platform-scoped".
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "audit_log"
          ("id", "tenantId", "actorType", "action", "resourceType", "after", "retentionClass")
        VALUES (
          gen_random_uuid(),
          '00000000-0000-0000-0000-000000000000'::uuid,
          'scheduled',
          ${AuditEvents.AUDIT_RETENTION_SWEEP_COMPLETED},
          'audit_log',
          ${JSON.stringify({ counts, totalDeleted, durationMs, completedAt })}::jsonb,
          'governance'
        )
      `);
    });

    return { counts, totalDeleted, durationMs, completedAt };
  }
}
