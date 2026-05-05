import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../common/prisma/prisma.service';
import { type AppConfig } from '../../config/configuration';

const SWEEP_BATCH = 200;

// Background worker that sweeps:
//   * Stale `pending` Document rows whose presigned PUT URL has long
//     expired but the row still claims uploadStatus='pending'. Flips
//     them to 'failed' so the discharge / claim-submit checklist no
//     longer surfaces them. Sprint 5 will additionally schedule an S3
//     lifecycle rule + delete the abandoned object.
//
// The scan-pending workflow is intentionally NOT in this worker —
// finalize runs the scanner synchronously today. When the real ClamAV
// adapter lands in Sprint 5, an async scan-pending sweep will live
// alongside this one.
@Injectable()
export class DocumentLifecycleWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly log = new Logger(DocumentLifecycleWorker.name);
  private readonly pendingTtlMs: number;
  private readonly tickIntervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {
    this.pendingTtlMs =
      this.config.get('DOC_PENDING_TTL_MINUTES', { infer: true }) * 60_000;
    this.tickIntervalMs = this.config.get('DOC_LIFECYCLE_TICK_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (this.config.get('DOC_LIFECYCLE_DISABLED' as never)) {
      this.log.log('DocumentLifecycleWorker disabled by env.');
      return;
    }
    this.scheduleNext();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // Single pass — exposed so tests can drive the worker deterministically.
  async runOnce(): Promise<{ swept: number }> {
    const cutoff = new Date(Date.now() - this.pendingTtlMs);

    // SELECT then UPDATE so we get a count + ids without trusting
    // updateMany to return them on every adapter version. RLS forces
    // tenant scoping; we sweep across tenants by running under
    // platform_admin since this is an internal hygiene job.
    const stale = await this.prisma.runInTenantContext(
      '00000000-0000-0000-0000-000000000000',
      'platform_admin',
      (tx) =>
        tx.document.findMany({
          where: {
            uploadStatus: 'pending',
            uploadedAt: { lt: cutoff },
          },
          select: { id: true, tenantId: true },
          take: SWEEP_BATCH,
        }),
    );
    if (stale.length === 0) return { swept: 0 };

    await this.prisma.runInTenantContext(
      '00000000-0000-0000-0000-000000000000',
      'platform_admin',
      (tx) =>
        tx.document.updateMany({
          where: { id: { in: stale.map((r) => r.id) } },
          data: {
            uploadStatus: 'failed',
            uploadError: 'pending upload exceeded TTL — never finalized',
          },
        }),
    );
    this.log.log(`document lifecycle swept ${stale.length} stale pending rows`);
    return { swept: stale.length };
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, this.tickIntervalMs);
    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`document lifecycle tick failed: ${message}`);
    } finally {
      this.running = false;
      this.scheduleNext();
    }
  }
}
