import {
  type IntegrationFailureClass,
  type IntegrationMessage,
  type IntegrationName,
} from '@claims/contracts';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';
import { type TenantPrisma } from '../../types/express';

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
