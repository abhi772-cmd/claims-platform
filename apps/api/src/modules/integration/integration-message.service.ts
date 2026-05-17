import {
  type IntegrationFailureClass,
  type IntegrationMessage,
  type IntegrationName,
} from '@claims/contracts';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';
import { type TenantPrisma } from '../../types/express';

// Used by cross-tenant sweep paths (replay worker). When running under
// the platform_admin role, set_config('app.tenant_id', ...) still needs
// a UUID-shaped value — this sentinel signals "no specific tenant".
const CROSS_TENANT_SENTINEL_UUID = '00000000-0000-0000-0000-000000000000';

export interface RecordOutboundInput {
  tenantId: string;
  claimId?: string;
  integration: IntegrationName;
  operation: string;
  correlationId: string;
  idempotencyKey?: string;
  rawRequest?: unknown;
}

@Injectable()
export class IntegrationMessageService {
  constructor(private readonly prisma: PrismaService) {}

  // Outbound write inside an existing tenant tx — keeps the ledger row
  // atomic with the surrounding state change (e.g. claim transition).
  async recordOutboundWithTx(
    tx: TenantPrisma,
    input: RecordOutboundInput,
  ): Promise<{ id: string }> {
    const row = await tx.integrationMessage.create({
      data: {
        tenantId: input.tenantId,
        ...(input.claimId !== undefined ? { claimId: input.claimId } : {}),
        direction: 'outbound',
        integration: input.integration,
        operation: input.operation,
        correlationId: input.correlationId,
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
        status: 'pending',
        rawRequest: (input.rawRequest ?? null) as never,
        lastAttemptAt: new Date(),
      },
      select: { id: true },
    });
    return row;
  }

  // Mark the outbound row succeeded + write the inbound response row.
  // Done in a fresh tx (the caller's outer tx may already be closed
  // by the time the network call returns).
  async markSucceeded(input: {
    tenantId: string;
    outboundId: string;
    correlationId: string;
    integration: IntegrationName;
    operation: string;
    claimId?: string;
    rawResponse: unknown;
  }): Promise<void> {
    await this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      await tx.integrationMessage.update({
        where: { id: input.outboundId },
        data: {
          status: 'succeeded',
          rawResponse: input.rawResponse as never,
          completedAt: new Date(),
        },
      });
      await tx.integrationMessage.create({
        data: {
          tenantId: input.tenantId,
          ...(input.claimId !== undefined ? { claimId: input.claimId } : {}),
          direction: 'inbound',
          integration: input.integration,
          operation: input.operation,
          correlationId: input.correlationId,
          status: 'succeeded',
          rawResponse: input.rawResponse as never,
          completedAt: new Date(),
          lastAttemptAt: new Date(),
        },
      });
    });
  }

  async markFailed(input: {
    tenantId: string;
    outboundId: string;
    correlationId: string;
    integration: IntegrationName;
    operation: string;
    claimId?: string;
    failureClass: IntegrationFailureClass;
    rawResponse?: unknown;
  }): Promise<void> {
    await this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      await tx.integrationMessage.update({
        where: { id: input.outboundId },
        data: {
          status: 'failed',
          failureClass: input.failureClass,
          retryCount: { increment: 1 },
          rawResponse: (input.rawResponse ?? null) as never,
          completedAt: new Date(),
        },
      });
      // Inbound row only when there's a body to record. Network errors
      // with no body don't get an inbound entry — the failed outbound
      // row carries the full story.
      if (input.rawResponse !== undefined) {
        await tx.integrationMessage.create({
          data: {
            tenantId: input.tenantId,
            ...(input.claimId !== undefined ? { claimId: input.claimId } : {}),
            direction: 'inbound',
            integration: input.integration,
            operation: input.operation,
            correlationId: input.correlationId,
            status: 'failed',
            failureClass: input.failureClass,
            rawResponse: input.rawResponse as never,
            completedAt: new Date(),
            lastAttemptAt: new Date(),
          },
        });
      }
    });
  }

  // T1-5 — replay queue helpers.
  //
  // Exponential backoff schedule (seconds): 60, 300, 1800, 7200, 21600.
  // Steps land roughly at attempt boundaries 1..5; beyond 5 the row
  // stays at 21600s (6h) until ops intervene. Worker treats the row
  // as terminally failed once retryCount >= REPLAY_MAX_ATTEMPTS.
  static readonly REPLAY_BACKOFF_SECONDS: readonly number[] = [
    60,
    300,
    1800,
    7200,
    21600,
  ];
  static readonly REPLAY_MAX_ATTEMPTS = 5;

  // Park a failed outbound for the NhcxReplayWorker. Increments
  // retryCount, sets nextRetryAt, and updates status. The original
  // outbound row stays in place — no duplicate row is written. The
  // worker re-issues the same correlationId on retry so idempotency
  // is preserved end-to-end.
  async markQueuedForRetry(input: {
    tenantId: string;
    outboundId: string;
    failureClass: IntegrationFailureClass;
    attemptsSoFar: number;
    now?: Date;
  }): Promise<{ nextRetryAt: Date; retryCount: number }> {
    const idx = Math.min(input.attemptsSoFar, IntegrationMessageService.REPLAY_BACKOFF_SECONDS.length - 1);
    const backoffSeconds = IntegrationMessageService.REPLAY_BACKOFF_SECONDS[idx] ?? 21600;
    const baseTime = (input.now ?? new Date()).getTime();
    const nextRetryAt = new Date(baseTime + backoffSeconds * 1000);

    const updated = await this.prisma.runInTenantContext(
      input.tenantId,
      'tenant',
      async (tx) => {
        return tx.integrationMessage.update({
          where: { id: input.outboundId },
          data: {
            status: 'queued_for_retry',
            failureClass: input.failureClass,
            retryCount: { increment: 1 },
            nextRetryAt,
            lastAttemptAt: new Date(baseTime),
          },
          select: { retryCount: true, nextRetryAt: true },
        });
      },
    );
    return {
      nextRetryAt: updated.nextRetryAt ?? nextRetryAt,
      retryCount: updated.retryCount,
    };
  }

  // Find replayable rows ready for re-issue across ALL tenants.
  //
  // Runs under runInTenantContext(SENTINEL_UUID, 'platform_admin', ...)
  // so the FORCE-RLS SELECT predicate on integration_message admits
  // rows from every tenant. The runtime role is claims_app
  // (NOSUPERUSER NOBYPASSRLS) — without the platform_admin GUC the
  // policy returns zero rows and the replay worker silently no-ops.
  //
  // Tenant boundaries are reasserted when the replay handler re-invokes
  // the owning service, which sets its own per-tenant GUC via
  // runInTenantContext(tenantId, 'tenant', ...). This worker only reads
  // the queue — it never mutates rows under platform_admin.
  //
  // Mirrors DocumentLifecycleWorker.runOnce.
  async findReplayable(
    options: { limit?: number; integration?: IntegrationName; now?: Date } = {},
  ): Promise<
    Array<{
      id: string;
      tenantId: string;
      claimId: string | null;
      integration: string;
      operation: string;
      correlationId: string;
      retryCount: number;
      idempotencyKey: string | null;
    }>
  > {
    const limit = Math.min(options.limit ?? 25, 100);
    const cutoff = options.now ?? new Date();
    return this.prisma.runInTenantContext(
      CROSS_TENANT_SENTINEL_UUID,
      'platform_admin',
      (tx) =>
        tx.integrationMessage.findMany({
          where: {
            status: 'queued_for_retry',
            nextRetryAt: { lte: cutoff },
            retryCount: { lt: IntegrationMessageService.REPLAY_MAX_ATTEMPTS },
            ...(options.integration !== undefined
              ? { integration: options.integration }
              : {}),
          },
          orderBy: { nextRetryAt: 'asc' },
          take: limit,
          select: {
            id: true,
            tenantId: true,
            claimId: true,
            integration: true,
            operation: true,
            correlationId: true,
            retryCount: true,
            idempotencyKey: true,
          },
        }),
    );
  }

  // Called by a replay handler when re-issue succeeds. Flips status
  // to 'succeeded', clears nextRetryAt, writes the inbound response
  // mirror row.
  async markReplaySucceeded(input: {
    tenantId: string;
    outboundId: string;
    correlationId: string;
    integration: IntegrationName;
    operation: string;
    claimId?: string;
    rawResponse: unknown;
  }): Promise<void> {
    await this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      await tx.integrationMessage.update({
        where: { id: input.outboundId },
        data: {
          status: 'succeeded',
          rawResponse: input.rawResponse as never,
          nextRetryAt: null,
          completedAt: new Date(),
        },
      });
      await tx.integrationMessage.create({
        data: {
          tenantId: input.tenantId,
          ...(input.claimId !== undefined ? { claimId: input.claimId } : {}),
          direction: 'inbound',
          integration: input.integration,
          operation: input.operation,
          correlationId: input.correlationId,
          status: 'succeeded',
          rawResponse: input.rawResponse as never,
          completedAt: new Date(),
          lastAttemptAt: new Date(),
        },
      });
    });
  }

  // Called when retries are exhausted or the failure has been
  // re-classified as permanent. Flips to 'failed' so ops can triage.
  async markReplayExhausted(input: {
    tenantId: string;
    outboundId: string;
    failureClass: IntegrationFailureClass;
  }): Promise<void> {
    await this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      await tx.integrationMessage.update({
        where: { id: input.outboundId },
        data: {
          status: 'failed',
          failureClass: input.failureClass,
          nextRetryAt: null,
          completedAt: new Date(),
        },
      });
    });
  }

  async listForClaim(tenantId: string, claimId: string): Promise<IntegrationMessage[]> {
    const rows = await this.prisma.runInTenantContext(tenantId, 'tenant', (tx) =>
      tx.integrationMessage.findMany({
        where: { claimId },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return rows.map((r) => ({
      id: r.id,
      direction: r.direction as IntegrationMessage['direction'],
      integration: r.integration as IntegrationName,
      operation: r.operation,
      correlationId: r.correlationId,
      status: r.status as IntegrationMessage['status'],
      failureClass: (r.failureClass as IntegrationFailureClass | null) ?? null,
      retryCount: r.retryCount,
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      rawRequest: r.rawRequest as unknown,
      rawResponse: r.rawResponse as unknown,
    }));
  }
}
