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
}
