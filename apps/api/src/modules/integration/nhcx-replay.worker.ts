import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { IntegrationMessageService } from './integration-message.service';

// T1-5 — NHCX outbound replay worker.
//
// Polls integration_message for status='queued_for_retry' rows whose
// nextRetryAt has lapsed, dispatches each to the registered handler
// for its operation, and the handler is responsible for re-issuing
// the original adapter call (re-deriving inputs from the current
// claim state, NOT replaying the stored rawRequest — claim state
// may have advanced).
//
// Handler registry is populated by services that opt in. The worker
// itself is operation-agnostic; mirrors the dispatch pattern used by
// the NHCX inbound controller.
//
// Concurrency: each API instance ticks independently. A naive race
// between two instances picking the same row is bounded by the row-
// level update inside markQueuedForRetry — the second instance's
// retry attempt is a no-op idempotency-wise (same correlationId,
// same idempotencyKey at the gateway).

export interface ReplayContext {
  outboundId: string;
  tenantId: string;
  claimId: string | null;
  operation: string;
  correlationId: string;
  retryCount: number;
  idempotencyKey: string | null;
}

// Operation-specific replay handler. Returns 'succeeded' to mark the
// row done, 'transient' to re-park (worker bumps retryCount + new
// nextRetryAt), 'permanent' to mark the row terminally failed.
export type ReplayOutcome = 'succeeded' | 'transient' | 'permanent';

export interface ReplayHandler {
  // The integration_message.operation value(s) this handler claims.
  // Multiple handlers can register; first registration wins.
  operation: string;
  // Re-issue the original outbound call. The handler reads current
  // claim/tenant state, builds the adapter request, and invokes the
  // adapter. On success the handler calls
  // IntegrationMessageService.markReplaySucceeded itself (matches
  // the synchronous-outbound pattern), then returns 'succeeded'.
  handle(ctx: ReplayContext): Promise<ReplayOutcome>;
}

// Injection token. Services register handlers in their module's
// useFactory and the worker collects them at bootstrap.
export const REPLAY_HANDLERS = Symbol('REPLAY_HANDLERS');

const TICK_INTERVAL_MS_DEFAULT = 30_000;
const BATCH_SIZE = 25;

@Injectable()
export class NhcxReplayWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(NhcxReplayWorker.name);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private readonly tickIntervalMs: number;
  private readonly handlerByOperation: Map<string, ReplayHandler>;

  constructor(
    private readonly integration: IntegrationMessageService,
    private readonly config: ConfigService,
  ) {
    this.tickIntervalMs =
      Number(this.config.get('NHCX_REPLAY_TICK_MS')) || TICK_INTERVAL_MS_DEFAULT;
    this.handlerByOperation = new Map();
  }

  // Services register replay handlers at module bootstrap time
  // (typically from their OnApplicationBootstrap hook). First
  // registration wins; subsequent calls for the same operation
  // are logged + ignored so a misconfigured re-bootstrap doesn't
  // silently swap behaviour.
  registerHandler(handler: ReplayHandler): void {
    if (this.handlerByOperation.has(handler.operation)) {
      this.log.warn(
        `replay handler conflict for operation=${handler.operation}; first registration kept`,
      );
      return;
    }
    this.handlerByOperation.set(handler.operation, handler);
    this.log.log(
      `replay handler registered operation=${handler.operation} totalHandlers=${this.handlerByOperation.size}`,
    );
  }

  // Test/ops helper to introspect the dispatch table.
  registeredOperations(): string[] {
    return Array.from(this.handlerByOperation.keys());
  }

  onApplicationBootstrap(): void {
    // Same env-gate pattern as NotificationRetryWorker. Integration
    // tests want deterministic ticks via runOnce() and don't want a
    // background timer firing while assertions run.
    if (this.config.get('NHCX_REPLAY_DISABLED')) {
      this.log.log('NhcxReplayWorker disabled by env.');
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

  // Single pass — exposed for deterministic test driving.
  async runOnce(now: Date = new Date()): Promise<{
    processed: number;
    succeeded: number;
    reparked: number;
    permanent: number;
    skipped: number;
  }> {
    const rows = await this.integration.findReplayable({
      limit: BATCH_SIZE,
      now,
      integration: 'nhcx',
    });
    let processed = 0;
    let succeeded = 0;
    let reparked = 0;
    let permanent = 0;
    let skipped = 0;

    for (const row of rows) {
      const handler = this.handlerByOperation.get(row.operation);
      if (!handler) {
        // No registered handler for this operation. The row stays
        // queued_for_retry — when the owning service registers a
        // handler in a future deploy, the row picks up automatically.
        // Log once per row so ops can see the gap.
        this.log.warn(
          `no replay handler for operation=${row.operation} outboundId=${row.id} — skipping`,
        );
        skipped += 1;
        continue;
      }
      processed += 1;
      const ctx: ReplayContext = {
        outboundId: row.id,
        tenantId: row.tenantId,
        claimId: row.claimId,
        operation: row.operation,
        correlationId: row.correlationId,
        retryCount: row.retryCount,
        idempotencyKey: row.idempotencyKey,
      };
      try {
        const outcome = await handler.handle(ctx);
        if (outcome === 'succeeded') {
          succeeded += 1;
        } else if (outcome === 'transient') {
          // Handler signalled transient failure again; re-park with
          // updated backoff. markQueuedForRetry handles the
          // increment + nextRetryAt math.
          await this.integration.markQueuedForRetry({
            tenantId: row.tenantId,
            outboundId: row.id,
            failureClass: 'network',
            attemptsSoFar: row.retryCount + 1,
            now,
          });
          reparked += 1;
        } else {
          await this.integration.markReplayExhausted({
            tenantId: row.tenantId,
            outboundId: row.id,
            failureClass: 'unknown',
          });
          permanent += 1;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn(
          `replay handler threw operation=${row.operation} outboundId=${row.id} err=${message}`,
        );
        // Treat unexpected throws as transient — they're often
        // network blips. Retries-exhausted is the long-term escape.
        await this.integration.markQueuedForRetry({
          tenantId: row.tenantId,
          outboundId: row.id,
          failureClass: 'unknown',
          attemptsSoFar: row.retryCount + 1,
          now,
        });
        reparked += 1;
      }
    }
    return { processed, succeeded, reparked, permanent, skipped };
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
      this.log.warn(`replay worker tick failed: ${message}`);
    } finally {
      this.running = false;
      this.scheduleNext();
    }
  }
}
