import { Injectable } from '@nestjs/common';

import { type AuditEvent } from './audit.events';
import { PrismaService } from '../../common/prisma/prisma.service';
import { type TenantPrisma } from '../../types/express';

export interface AuditWriteInput {
  tenantId: string;
  actorUserId?: string | null;
  actorType: 'user' | 'system' | 'scheduled';
  action: AuditEvent;
  resourceType: string;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

export interface AuditListInput {
  tenantId: string;
  limit: number;
  offset: number;
  from?: Date;
  to?: Date;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  actorUserId?: string;
  correlationId?: string;
}

export interface AuditListedRow {
  id: string;
  occurredAt: Date;
  actorUserId: string | null;
  actorType: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  before: unknown;
  after: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  correlationId: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
// Cap on rows streamed by export. Above this, the operator should add
// filters or use a paginated dump. Protects API memory + the operator
// from accidentally pulling 10M rows in one CSV.
const EXPORT_HARD_CAP = 100_000;

// Writes a row into audit_log. Two call paths:
//  - From inside a tenant-scoped transaction: call recordWithTx(tx, ...) so
//    the row commits atomically with the surrounding state change.
//  - From outside any transaction: call record(...) and we open a dedicated
//    platform_admin tenant context.
//
// Append-only is enforced by RLS; UPDATE/DELETE on audit_log are silently
// dropped at the database. See migration 20260503000001_rls.
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditWriteInput): Promise<void> {
    await this.prisma.runInTenantContext(input.tenantId, 'platform_admin', async (tx) => {
      await this.recordWithTx(tx, input);
    });
  }

  async recordWithTx(tx: TenantPrisma, input: AuditWriteInput): Promise<void> {
    await tx.auditLog.create({
      data: {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId ?? null,
        actorType: input.actorType,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        before: (input.before ?? null) as never,
        after: (input.after ?? null) as never,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        correlationId: input.correlationId ?? null,
      },
    });
  }

  // Slice V — list audit rows for the viewer. Always tenant-scoped via
  // the runtime GUC; platform_admin callers see their tenant's rows
  // because the controller passes user.tenantId, not platform-scope.
  async list(input: AuditListInput): Promise<{ rows: AuditListedRow[]; total: number }> {
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(input.limit || DEFAULT_LIMIT)));
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    return this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const where = this.buildWhere(input);
      const [rows, total] = await Promise.all([
        tx.auditLog.findMany({
          where,
          orderBy: { occurredAt: 'desc' },
          skip: offset,
          take: limit,
        }),
        tx.auditLog.count({ where }),
      ]);
      return { rows, total };
    });
  }

  // Stream rows in batches for CSV export. Returns an async generator;
  // the controller pipes each yielded row directly into the response
  // so we never hold the full result set in memory. Capped at
  // EXPORT_HARD_CAP rows to bound the worst case.
  async *streamForExport(
    input: Omit<AuditListInput, 'limit' | 'offset'>,
  ): AsyncGenerator<AuditListedRow, void, void> {
    const where = this.buildWhere(input);
    const pageSize = 500;
    let yielded = 0;
    let cursor: string | undefined;
    while (yielded < EXPORT_HARD_CAP) {
      const batch: AuditListedRow[] = await this.prisma.runInTenantContext(
        input.tenantId,
        'tenant',
        (tx) =>
          tx.auditLog.findMany({
            where,
            orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
            take: pageSize,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          }),
      );
      if (batch.length === 0) return;
      for (const row of batch) {
        yield row;
        yielded += 1;
        if (yielded >= EXPORT_HARD_CAP) return;
      }
      cursor = batch[batch.length - 1]?.id;
      if (!cursor) return;
    }
  }

  private buildWhere(input: Partial<AuditListInput>): {
    occurredAt?: { gte?: Date; lt?: Date };
    action?: string;
    resourceType?: string;
    resourceId?: string;
    actorUserId?: string;
    correlationId?: string;
  } {
    const where: ReturnType<AuditService['buildWhere']> = {};
    if (input.from || input.to) {
      where.occurredAt = {
        ...(input.from ? { gte: input.from } : {}),
        ...(input.to ? { lt: input.to } : {}),
      };
    }
    if (input.action) where.action = input.action;
    if (input.resourceType) where.resourceType = input.resourceType;
    if (input.resourceId) where.resourceId = input.resourceId;
    if (input.actorUserId) where.actorUserId = input.actorUserId;
    if (input.correlationId) where.correlationId = input.correlationId;
    return where;
  }
}
