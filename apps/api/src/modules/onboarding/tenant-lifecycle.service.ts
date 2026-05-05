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
    // 1. FSM check first — cheap and the most fundamental gate. Doing
    //    this before readiness means a CHURNED → LIVE attempt produces
    //    LIFECYCLE_TRANSITION_INVALID rather than the noisier (and
    //    correct-but-irrelevant) READINESS_CHECK_FAILED.
    const before = await this.prisma.runInTenantContext(
      input.tenantId,
      'tenant',
      (tx) =>
        tx.tenant.findUnique({
          where: { id: input.tenantId },
          select: { lifecycleState: true },
        }),
    );
    if (!before) throw new LifecycleTransitionInvalidError('Tenant not found.');
    const from = before.lifecycleState;
    if (!isTransitionAllowed(from, input.target)) {
      throw new LifecycleTransitionInvalidError(
        `Transition ${from} → ${input.target} is not allowed.`,
      );
    }

    // 2. Readiness gate (PILOT/LIVE only). Outside the tx — it queries
    //    multiple tables.
    if (READINESS_GATED_TARGETS.has(input.target)) {
      const report = await this.readiness.run(input.tenantId);
      if (!report.ready) {
        throw new ReadinessCheckFailedError(
          `Cannot transition to ${input.target} until readiness checks pass.`,
        );
      }
    }

    // 3. Apply. Re-check FSM inside the tx in case the state changed
    //    between the read above and this write.
    return this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const fresh = await tx.tenant.findUnique({
        where: { id: input.tenantId },
        select: { lifecycleState: true },
      });
      if (!fresh) throw new LifecycleTransitionInvalidError('Tenant not found.');
      if (!isTransitionAllowed(fresh.lifecycleState, input.target)) {
        throw new LifecycleTransitionInvalidError(
          `Transition ${fresh.lifecycleState} → ${input.target} is not allowed.`,
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
        before: { lifecycleState: fresh.lifecycleState },
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
