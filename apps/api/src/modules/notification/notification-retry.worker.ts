import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EmailAdapter } from './email.adapter';
import { type NotificationChannel, type RenderedNotification, type TemplateData, type TemplateKey } from './notification.types';
import { SmsAdapter } from './sms.adapter';
import { renderTemplate } from './templates';
import { PrismaService } from '../../common/prisma/prisma.service';

const MAX_ATTEMPTS_DEFAULT = 5;
const TICK_INTERVAL_MS_DEFAULT = 30_000;
const BATCH_SIZE = 25;

// Used for cross-tenant sweep — the worker reads queued/failed rows
// from every tenant under platform_admin. set_config('app.tenant_id', ...)
// still needs a UUID-shaped value; this sentinel signals "no specific tenant".
const CROSS_TENANT_SENTINEL_UUID = '00000000-0000-0000-0000-000000000000';

// Worker that drains notification_outbox rows in 'queued' or 'failed'
// state with attempts < cap. Runs in-process — every API instance ticks
// independently. Concurrency is bounded by the row-level lock the
// service takes when flipping status; if two instances pick the same
// row, only the first update wins. Worst case is two delivery attempts
// for one row, which the SMTP/SMS adapters tolerate (idempotent at the
// recipient level: same message arrives twice rather than not at all).
//
// Retry schedule is exponential back-off based on attempts:
//   attempt 1 → eligible immediately
//   attempt 2 → +60s
//   attempt 3 → +5m
//   attempt 4 → +30m
//   attempt 5 → +2h
// Beyond MAX_ATTEMPTS the row stays 'failed' and is left for ops.
const BACKOFF_SECONDS = [0, 60, 300, 1800, 7200];

@Injectable()
export class NotificationRetryWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(NotificationRetryWorker.name);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private readonly maxAttempts: number;
  private readonly tickIntervalMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailAdapter,
    private readonly sms: SmsAdapter,
    private readonly config: ConfigService,
  ) {
    this.maxAttempts =
      Number(this.config.get('NOTIFICATION_RETRY_MAX_ATTEMPTS')) || MAX_ATTEMPTS_DEFAULT;
    this.tickIntervalMs =
      Number(this.config.get('NOTIFICATION_RETRY_TICK_MS')) || TICK_INTERVAL_MS_DEFAULT;
  }

  onApplicationBootstrap(): void {
    // Skip during integration tests — they boot the AppModule but don't
    // want a background timer firing while assertions run. Tests that
    // explicitly want the worker call `runOnce()` directly.
    if (this.config.get('NOTIFICATION_RETRY_DISABLED')) {
      this.log.log('NotificationRetryWorker disabled by env.');
      return;
    }
    this.scheduleNext();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    // Wait for any in-flight tick to settle so jest doesn't see leaks.
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // Single pass — exposed so tests can drive the worker deterministically.
  async runOnce(): Promise<{ processed: number; sent: number; failed: number }> {
    let processed = 0;
    let sent = 0;
    let failed = 0;
    const now = new Date();

    // Pull a small batch of rows under platform_admin so the FORCE-RLS
    // SELECT predicate on notification_outbox admits rows from every
    // tenant. The runtime role is claims_app (NOSUPERUSER NOBYPASSRLS) —
    // without runInTenantContext + 'platform_admin', the policy returns
    // zero rows and the worker silently no-ops every tick. Mirrors
    // DocumentLifecycleWorker.runOnce.
    const rows = await this.prisma.runInTenantContext(
      CROSS_TENANT_SENTINEL_UUID,
      'platform_admin',
      (tx) =>
        tx.notificationOutbox.findMany({
          where: {
            status: { in: ['queued', 'failed'] },
            attempts: { lt: this.maxAttempts },
          },
          orderBy: { scheduledAt: 'asc' },
          take: BATCH_SIZE,
        }),
    );

    for (const row of rows) {
      const nextEligibleAt = computeNextEligibleAt(row.scheduledAt, row.attempts);
      if (nextEligibleAt > now) continue;
      processed += 1;
      const ok = await this.attemptDeliver(row);
      if (ok) sent += 1;
      else failed += 1;
    }

    return { processed, sent, failed };
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, this.tickIntervalMs);
    // unref so the timer doesn't keep the Node process alive in tests
    // that forget to call onApplicationShutdown.
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
      this.log.warn(`retry worker tick failed: ${message}`);
    } finally {
      this.running = false;
      this.scheduleNext();
    }
  }

  private async attemptDeliver(row: {
    id: string;
    tenantId: string;
    channel: string;
    templateKey: string;
    recipient: string;
    payload: unknown;
    attempts: number;
  }): Promise<boolean> {
    const rendered = this.tryRender(row.templateKey, row.payload);
    if (!rendered) {
      // Template doesn't exist or payload invalid — mark failed and move
      // on. Don't retry; this is a permanent error.
      await this.markPermanentlyFailed(row.tenantId, row.id, 'unrenderable_template');
      return false;
    }

    try {
      if (row.channel === 'email' && rendered.email) {
        await this.email.send(row.tenantId, row.recipient, rendered.email);
      } else if (row.channel === 'sms' && rendered.sms) {
        await this.sms.send(row.tenantId, row.recipient, rendered.sms);
      } else {
        // Channel mismatch (e.g. row says 'email' but the template only
        // has 'sms'). Permanent failure.
        await this.markPermanentlyFailed(row.tenantId, row.id, 'channel_mismatch');
        return false;
      }
      await this.prisma.runInTenantContext(row.tenantId, 'platform_admin', (tx) =>
        tx.notificationOutbox.update({
          where: { id: row.id },
          data: {
            status: 'sent',
            sentAt: new Date(),
            attempts: { increment: 1 },
            lastError: null,
          },
        }),
      );
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(
        `retry deliver failed rowId=${row.id} channel=${row.channel} err=${message}`,
      );
      const willRetry = row.attempts + 1 < this.maxAttempts;
      await this.prisma.runInTenantContext(row.tenantId, 'platform_admin', (tx) =>
        tx.notificationOutbox.update({
          where: { id: row.id },
          data: {
            status: 'failed',
            attempts: { increment: 1 },
            lastError: message.slice(0, 1000),
            ...(willRetry ? {} : {}),
          },
        }),
      );
      return false;
    }
  }

  private tryRender(
    templateKey: string,
    payload: unknown,
  ): RenderedNotification | null {
    try {
      // Template registry is keyed by the small enum in
      // notification.types — coerce + render. Failures (unknown key,
      // bad payload shape) bubble as throws and we treat them as
      // unrenderable. This is the only place we accept payload shape
      // dynamically; service code uses TemplateData<K> for compile-time
      // safety.
      return renderTemplate(
        templateKey as TemplateKey,
        payload as TemplateData[TemplateKey],
      );
    } catch {
      return null;
    }
  }

  private async markPermanentlyFailed(
    tenantId: string,
    rowId: string,
    reason: string,
  ): Promise<void> {
    await this.prisma.runInTenantContext(tenantId, 'platform_admin', (tx) =>
      tx.notificationOutbox.update({
        where: { id: rowId },
        data: {
          status: 'failed',
          attempts: this.maxAttempts,
          lastError: reason,
        },
      }),
    );
  }
}

// Exported for unit tests + monitoring.
export function computeNextEligibleAt(scheduledAt: Date, attempts: number): Date {
  const idx = Math.min(attempts, BACKOFF_SECONDS.length - 1);
  const delaySec = BACKOFF_SECONDS[idx] ?? 0;
  return new Date(scheduledAt.getTime() + delaySec * 1000);
}

// Re-exported so the worker stays self-contained for module wiring.
export type { NotificationChannel };
