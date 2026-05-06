import {
  type ClaimEventType,
  type ClaimRail,
  type ClaimStatus,
} from '@claims/contracts';
import { Injectable } from '@nestjs/common';

import { isTransitionAllowed, nextStatus, TERMINAL_STATUSES } from './claim.state-machine';
import { ClaimNotFoundError, InvalidClaimTransitionError } from '../../common/errors/claim-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { type TenantPrisma } from '../../types/express';

export interface CreateClaimInput {
  tenantId: string;
  caseId: string;
  rail: ClaimRail;
  actorUserId: string;
  occurredAt?: Date;
  payload?: Record<string, unknown>;
  correlationId?: string;
}

export interface TransitionInput {
  tenantId: string;
  claimId: string;
  eventType: ClaimEventType;
  actorUserId: string | null;
  occurredAt?: Date;
  payload?: Record<string, unknown>;
  correlationId?: string;
  // Materialised-state field updates that the caller wants to apply
  // alongside the status change (e.g. set approvedAmount on an
  // approval). Validated against the column shape by Prisma; we don't
  // double-validate here.
  patch?: {
    preauthAmount?: number;
    claimAmount?: number;
    approvedAmount?: number;
    paidAmount?: number;
    preauthRefNum?: string;
    claimRefNum?: string;
    payerRefNum?: string;
    payerCode?: string;
    submittedAt?: Date;
    approvedAt?: Date;
    paidAt?: Date;
    closedAt?: Date;
    assignedToUserId?: string;
  };
}

export interface ClaimSnapshot {
  id: string;
  tenantId: string;
  caseId: string;
  rail: ClaimRail;
  status: ClaimStatus;
  preauthAmount: number | null;
  claimAmount: number | null;
  approvedAmount: number | null;
  paidAmount: number | null;
  preauthRefNum: string | null;
  claimRefNum: string | null;
  payerRefNum: string | null;
  initiatedAt: Date;
  closedAt: Date | null;
}

@Injectable()
export class ClaimService {
  constructor(private readonly prisma: PrismaService) {}

  // Create a new claim by emitting `case.created`. The state machine
  // says null → INITIATED on this event. The Claim row is materialised
  // here AND the first ClaimEvent is written, atomically.
  async create(input: CreateClaimInput): Promise<ClaimSnapshot> {
    const initial = nextStatus(null, 'case.created');
    if (initial === null) {
      // Defensive: the transition table should always allow case.created
      // from null. If someone removes that row, we surface it loudly
      // rather than silently produce a claim with the wrong status.
      throw new Error('State machine misconfigured: case.created has no target.');
    }
    return this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const claim = await tx.claim.create({
        data: {
          tenantId: input.tenantId,
          caseId: input.caseId,
          rail: input.rail,
          status: initial,
        },
      });
      await tx.claimEvent.create({
        data: {
          tenantId: input.tenantId,
          claimId: claim.id,
          eventType: 'case.created',
          resultingStatus: initial,
          occurredAt: input.occurredAt ?? new Date(),
          recordedById: input.actorUserId,
          payload: (input.payload ?? {}) as never,
          correlationId: input.correlationId ?? null,
          prevEventId: null,
        },
      });
      return toSnapshot(claim);
    });
  }

  async transition(input: TransitionInput): Promise<ClaimSnapshot> {
    return this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const claim = await tx.claim.findUnique({ where: { id: input.claimId } });
      if (!claim || claim.tenantId !== input.tenantId) throw new ClaimNotFoundError();

      const from = claim.status as ClaimStatus;
      const to = nextStatus(from, input.eventType);
      if (to === null || !isTransitionAllowed(from, input.eventType)) {
        throw new InvalidClaimTransitionError(
          `Event ${input.eventType} not allowed from status ${from}.`,
        );
      }

      // Find the previous event for chain pointer (cheap — index on claimId+occurredAt).
      const prev = await tx.claimEvent.findFirst({
        where: { claimId: input.claimId },
        orderBy: { occurredAt: 'desc' },
        select: { id: true },
      });

      await tx.claimEvent.create({
        data: {
          tenantId: input.tenantId,
          claimId: input.claimId,
          eventType: input.eventType,
          resultingStatus: to,
          occurredAt: input.occurredAt ?? new Date(),
          recordedById: input.actorUserId,
          payload: (input.payload ?? {}) as never,
          correlationId: input.correlationId ?? null,
          prevEventId: prev?.id ?? null,
        },
      });

      // Auto-stamp common timestamp columns based on the resulting status
      // so callers don't have to remember which lifecycle moment fills
      // which timestamp. The patch-supplied values still win.
      const autoPatch: Partial<TransitionInput['patch']> = {};
      if ((to === 'PREAUTH_SUBMITTED' || to === 'CLAIM_SUBMITTED') && !claim.submittedAt) {
        autoPatch.submittedAt = input.occurredAt ?? new Date();
      }
      if ((to === 'PREAUTH_APPROVED' || to === 'CLAIM_APPROVED') && !claim.approvedAt) {
        autoPatch.approvedAt = input.occurredAt ?? new Date();
      }
      if (to === 'PAYMENT_RECEIVED' && !claim.paidAt) {
        autoPatch.paidAt = input.occurredAt ?? new Date();
      }
      if (TERMINAL_STATUSES.has(to) && !claim.closedAt) {
        autoPatch.closedAt = input.occurredAt ?? new Date();
      }

      const updated = await tx.claim.update({
        where: { id: input.claimId },
        data: {
          status: to,
          ...autoPatch,
          ...(input.patch ?? {}),
        },
      });
      return toSnapshot(updated);
    });
  }

  async findById(tenantId: string, claimId: string): Promise<ClaimSnapshot | null> {
    const claim = await this.prisma.runInTenantContext(tenantId, 'tenant', (tx) =>
      tx.claim.findUnique({ where: { id: claimId } }),
    );
    return claim ? toSnapshot(claim) : null;
  }

  // For the reconstruction tests / disputes view. Returns events ordered
  // oldest-first, matching the order they happened.
  async listEvents(tenantId: string, claimId: string): Promise<
    Array<{
      id: string;
      eventType: ClaimEventType;
      resultingStatus: ClaimStatus;
      occurredAt: Date;
      recordedAt: Date;
      recordedById: string | null;
      payload: Record<string, unknown>;
      correlationId: string | null;
      prevEventId: string | null;
    }>
  > {
    const rows = await this.prisma.runInTenantContext(tenantId, 'tenant', (tx) =>
      tx.claimEvent.findMany({
        where: { claimId },
        orderBy: { occurredAt: 'asc' },
      }),
    );
    return rows.map((r) => ({
      id: r.id,
      eventType: r.eventType as ClaimEventType,
      resultingStatus: r.resultingStatus as ClaimStatus,
      occurredAt: r.occurredAt,
      recordedAt: r.recordedAt,
      recordedById: r.recordedById,
      payload: (r.payload as Record<string, unknown>) ?? {},
      correlationId: r.correlationId,
      prevEventId: r.prevEventId,
    }));
  }
}

type RawClaim = Awaited<ReturnType<TenantPrisma['claim']['findUnique']>>;

function toSnapshot(c: NonNullable<RawClaim>): ClaimSnapshot {
  return {
    id: c.id,
    tenantId: c.tenantId,
    caseId: c.caseId,
    rail: c.rail as ClaimRail,
    status: c.status as ClaimStatus,
    preauthAmount: c.preauthAmount,
    claimAmount: c.claimAmount,
    approvedAmount: c.approvedAmount,
    paidAmount: c.paidAmount,
    preauthRefNum: c.preauthRefNum,
    claimRefNum: c.claimRefNum,
    payerRefNum: c.payerRefNum,
    initiatedAt: c.initiatedAt,
    closedAt: c.closedAt,
  };
}
