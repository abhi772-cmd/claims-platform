import { Injectable } from '@nestjs/common';
import { type TenantLifecycleState } from '@prisma/client';

import { allowedTargets, isTransitionAllowed, READINESS_GATED_TARGETS } from './lifecycle-fsm';
import { ReadinessService } from './readiness.service';
import { LifecycleTransitionInvalidError, ReadinessCheckFailedError } from '../../common/errors/tenant-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditEvents, AuditService } from '../audit';

export interface TransitionInput {
  tenantId: string;
  actorUserId: string;
  target: TenantLifecycleState;
  reason?: string;
  ip: string | null;
  userAgent: string | null;
}

@Injectable()
export class TenantLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly readiness: ReadinessService,
  ) {}

  async getState(tenantId: string): Promise<{
    state: TenantLifecycleState;
    allowedTargets: readonly TenantLifecycleState[];
  }> {
    const tenant = await this.prisma.runInTenantContext(tenantId, 'tenant', (tx) =>
      tx.tenant.findUnique({ where: { id: tenantId }, select: { lifecycleState: true } }),
    );
    const state = tenant?.lifecycleState ?? 'IN_SETUP';
    return { state, allowedTargets: allowedTargets(state) };
  }

  async transition(input: TransitionInput): Promise<{
    state: TenantLifecycleState;
    allowedTargets: readonly TenantLifecycleState[];
  }> {
    // Readiness check is OUTSIDE the tx — it queries multiple tables and
    // we don't want to hold locks while computing.
    if (READINESS_GATED_TARGETS.has(input.target)) {
      const report = await this.readiness.run(input.tenantId);
      if (!report.ready) {
        throw new ReadinessCheckFailedError(
          `Cannot transition to ${input.target} until readiness checks pass.`,
        );
      }
    }

    return this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const before = await tx.tenant.findUnique({
        where: { id: input.tenantId },
        select: { lifecycleState: true },
      });
      if (!before) throw new LifecycleTransitionInvalidError('Tenant not found.');
      const from = before.lifecycleState;
      if (!isTransitionAllowed(from, input.target)) {
        throw new LifecycleTransitionInvalidError(
          `Transition ${from} → ${input.target} is not allowed.`,
        );
      }
      const updated = await tx.tenant.update({
        where: { id: input.tenantId },
        data: { lifecycleState: input.target },
        select: { lifecycleState: true },
      });
      await this.audit.recordWithTx(tx, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        actorType: 'user',
        action: AuditEvents.TENANT_LIFECYCLE_TRANSITION,
        resourceType: 'tenant',
        resourceId: input.tenantId,
        before: { lifecycleState: from },
        after: {
          lifecycleState: input.target,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        },
        ipAddress: input.ip,
        userAgent: input.userAgent,
      });
      return {
        state: updated.lifecycleState,
        allowedTargets: allowedTargets(updated.lifecycleState),
      };
    });
  }
}
