import {
  type AppealResolutionKind,
  type AppealResponse,
  type AppealStatus,
  type AppealSummary,
} from '@claims/contracts';
import { Injectable, Logger } from '@nestjs/common';

import { InvalidClaimTransitionError } from '../../common/errors/claim-errors';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ClaimService } from '../claim';

export interface StartAppealInput {
  tenantId: string;
  claimId: string;
  actorUserId: string;
  reason: string;
}

export interface SubmitAppealInput {
  tenantId: string;
  claimId: string;
  actorUserId: string;
  supportingDocumentIds: string[];
}

export interface ResolveAppealInput {
  tenantId: string;
  claimId: string;
  actorUserId: string;
  kind: AppealResolutionKind;
  approvedAmount?: number;
  note?: string;
}

// Lifecycle:
//   start    — creates the Appeal row + drives appeal.started on the
//              claim (PREAUTH_REJECTED / CLAIM_REJECTED / SHORT_PAID
//              → APPEAL_INITIATED). Rejected upstream by the state
//              machine when the claim isn't in an appealable state.
//   submit   — finalises the appeal package + drives appeal.submitted
//              (APPEAL_INITIATED → APPEAL_SUBMITTED). The "send to
//              the payer" leg is a Sprint 5 backlog item — for now
//              we just freeze the package locally.
//   resolve  — operator records the payer's decision + drives
//              appeal.resolved (APPEAL_SUBMITTED → APPEAL_RESOLVED).
//              Approved / partially_approved stamps approvedAmount on
//              the claim. The next-step transitions (payment.expected
//              when favourable, claim.written_off when not) are
//              triggered separately via SettlementService — keeping
//              that boundary so settlement remains the only writer
//              of payment-related state.
@Injectable()
export class AppealService {
  private readonly log = new Logger(AppealService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly claims: ClaimService,
  ) {}

  async start(input: StartAppealInput): Promise<AppealResponse> {
    // 1. Drive the state-machine transition first. If the claim is
    // not in an appealable state, the transition throws and we never
    // create an Appeal row — keeps the table consistent with the
    // claim's lifecycle.
    const snap = await this.claims.transition({
      tenantId: input.tenantId,
      claimId: input.claimId,
      eventType: 'appeal.started',
      actorUserId: input.actorUserId,
      payload: { reason: input.reason },
    });

    // 2. Create the Appeal row inside a tenant-context tx so RLS
    // applies. The claim transition above already wrote a claim_event.
    const row = await this.prisma.runInTenantContext(input.tenantId, 'tenant', (tx) =>
      tx.appeal.create({
        data: {
          tenantId: input.tenantId,
          claimId: input.claimId,
          reason: input.reason,
          status: 'initiated',
          startedByUserId: input.actorUserId,
        },
      }),
    );
    this.log.log(`appeal started claimId=${input.claimId} appealId=${row.id}`);
    return { appeal: toSummary(row), claimStatus: snap.status };
  }

  async submit(input: SubmitAppealInput): Promise<AppealResponse> {
    // 1. Find the open appeal (the most recent row for this claim that
    // isn't already resolved). At-most-one-active is enforced
    // implicitly: appeal.started would have been rejected by the
    // state machine if the claim were already at APPEAL_INITIATED /
    // APPEAL_SUBMITTED, so a fresh start() always begets the only
    // open row.
    const open = await this.findOpenAppeal(input.tenantId, input.claimId);
    if (!open) {
      throw new ValidationFailedError({
        appeal: ['No open appeal found for this claim. Call /appeal/start first.'],
      });
    }
    if (open.status !== 'initiated') {
      throw new InvalidClaimTransitionError(
        `Appeal is already ${open.status}; only an initiated appeal can be submitted.`,
      );
    }

    // 2. Drive the transition + update the row. State-machine
    // adherence is up to ClaimService.transition.
    const snap = await this.claims.transition({
      tenantId: input.tenantId,
      claimId: input.claimId,
      eventType: 'appeal.submitted',
      actorUserId: input.actorUserId,
    });
    const row = await this.prisma.runInTenantContext(input.tenantId, 'tenant', (tx) =>
      tx.appeal.update({
        where: { id: open.id },
        data: {
          status: 'submitted',
          submittedAt: new Date(),
          supportingDocuments: input.supportingDocumentIds as never,
        },
      }),
    );
    return { appeal: toSummary(row), claimStatus: snap.status };
  }

  async resolve(input: ResolveAppealInput): Promise<AppealResponse> {
    if (input.kind !== 'rejected' && (input.approvedAmount ?? 0) <= 0) {
      throw new ValidationFailedError({
        approvedAmount: [
          'approvedAmount is required and must be positive for approved / partially_approved.',
        ],
      });
    }
    const open = await this.findOpenAppeal(input.tenantId, input.claimId);
    if (!open) {
      throw new ValidationFailedError({
        appeal: ['No open appeal found for this claim.'],
      });
    }
    if (open.status !== 'submitted') {
      throw new InvalidClaimTransitionError(
        `Appeal is in status=${open.status}; only a submitted appeal can be resolved.`,
      );
    }

    // 1. Drive state-machine transition.
    const transitionPatch: Record<string, unknown> = {};
    if (input.kind !== 'rejected' && input.approvedAmount !== undefined) {
      transitionPatch['approvedAmount'] = input.approvedAmount;
    }
    const snap = await this.claims.transition({
      tenantId: input.tenantId,
      claimId: input.claimId,
      eventType: 'appeal.resolved',
      actorUserId: input.actorUserId,
      payload: {
        kind: input.kind,
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
      ...(Object.keys(transitionPatch).length > 0 ? { patch: transitionPatch } : {}),
    });

    // 2. Update the appeal row.
    const row = await this.prisma.runInTenantContext(input.tenantId, 'tenant', (tx) =>
      tx.appeal.update({
        where: { id: open.id },
        data: {
          status: 'resolved',
          resolvedAt: new Date(),
          resolutionKind: input.kind,
          ...(input.note !== undefined ? { resolutionNote: input.note } : {}),
          ...(input.approvedAmount !== undefined
            ? { approvedAmount: input.approvedAmount }
            : {}),
        },
      }),
    );
    return { appeal: toSummary(row), claimStatus: snap.status };
  }

  async getOpenForClaim(
    tenantId: string,
    claimId: string,
  ): Promise<AppealSummary | null> {
    const row = await this.findOpenAppeal(tenantId, claimId);
    return row ? toSummary(row) : null;
  }

  private async findOpenAppeal(
    tenantId: string,
    claimId: string,
  ): Promise<AppealRow | null> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', (tx) =>
      tx.appeal.findFirst({
        where: { claimId },
        orderBy: { startedAt: 'desc' },
      }),
    );
  }
}

interface AppealRow {
  id: string;
  claimId: string;
  status: string;
  reason: string;
  supportingDocuments: unknown;
  resolutionKind: string | null;
  resolutionNote: string | null;
  approvedAmount: number | null;
  startedAt: Date;
  submittedAt: Date | null;
  resolvedAt: Date | null;
}

function toSummary(row: AppealRow): AppealSummary {
  const docs = Array.isArray(row.supportingDocuments)
    ? (row.supportingDocuments as unknown[]).filter(
        (v): v is string => typeof v === 'string',
      )
    : [];
  return {
    id: row.id,
    claimId: row.claimId,
    status: row.status as AppealStatus,
    reason: row.reason,
    supportingDocumentIds: docs,
    resolutionKind:
      row.resolutionKind === null ? null : (row.resolutionKind as AppealResolutionKind),
    resolutionNote: row.resolutionNote,
    approvedAmount: row.approvedAmount,
    startedAt: row.startedAt.toISOString(),
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  };
}
