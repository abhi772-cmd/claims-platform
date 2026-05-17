// EOB-line matcher service.
//
// Phase 1 — loads Settlement.deductions + bill_line_item rows and
//           hands them to the pure matcher.
// Phase 2 — also loads reviewer-confirmed matches, merges them
//           into the pure-matcher input, and exposes confirm /
//           reset operations that write to eob_line_match.

import {
  type ConfirmEobLineMatchRequest,
  type EobLineMatchesResponse,
} from '@claims/contracts';
import { Injectable } from '@nestjs/common';

import { matchEobLines, type ConfirmedEobLineMatch } from './match-eob-lines';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditEvents, AuditService } from '../audit';
import { BillLineItemService } from '../bill-line-item/bill-line-item.service';
import { SettlementService } from '../settlement/settlement.service';

export interface ConfirmInput {
  tenantId: string;
  claimId: string;
  actorUserId: string;
  request: ConfirmEobLineMatchRequest;
  ip?: string | null;
  userAgent?: string | null;
}

export interface ResetInput {
  tenantId: string;
  claimId: string;
  actorUserId: string;
  deductionIndex: number;
  ip?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class EobLineMatcherService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billLines: BillLineItemService,
    private readonly settlements: SettlementService,
    private readonly audit: AuditService,
  ) {}

  async suggestForClaim(
    tenantId: string,
    claimId: string,
  ): Promise<EobLineMatchesResponse> {
    // Parallel reads — all three go through their own tenant
    // context. No cross-table tx needed; this is read-only.
    // Phase 3 — include join rows so we replay multi-line
    // confirmations with their full member set.
    const [settlement, billLinesResp, confirmedRows] = await Promise.all([
      this.settlements.getByClaim(tenantId, claimId),
      this.billLines.listForClaim(tenantId, claimId),
      this.prisma.runInTenantContext(tenantId, 'tenant', (tx) =>
        tx.eobLineMatch.findMany({
          where: { claimId },
          orderBy: { deductionIndex: 'asc' },
          include: { additionalBillLineItems: true },
        }),
      ),
    ]);

    const deductions = settlement?.deductions ?? [];
    const confirmed: ConfirmedEobLineMatch[] = confirmedRows.map((r) => ({
      deductionIndex: r.deductionIndex,
      billLineItemId: r.billLineItemId,
      additionalBillLineItemIds: r.additionalBillLineItems.map(
        (item) => item.billLineItemId,
      ),
      isDispute: r.isDispute,
      confirmedById: r.confirmedById,
      confirmedAt: r.confirmedAt.toISOString(),
    }));

    const result = matchEobLines({
      deductions,
      billLines: billLinesResp.lines,
      confirmed,
    });

    return {
      matches: result.matches,
      unmatchedBillLineIds: result.unmatchedBillLineIds,
      totalDeductionAmount: result.totalDeductionAmount,
      totalMatchedAmount: result.totalMatchedAmount,
      disputeCandidateCount: result.disputeCandidateCount,
    };
  }

  // Phase 2/3 — confirm one deduction's match. Upsert semantics:
  // re-confirming overwrites the previous record (delete-then-
  // insert inside a tenant tx so RLS + the unique index hold).
  // Phase 3 — `additionalBillLineItemIds` populates the
  // eob_line_match_item join table; the join rows cascade with
  // the parent eob_line_match on the deleteMany above.
  async confirm(input: ConfirmInput): Promise<EobLineMatchesResponse> {
    await this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      await tx.eobLineMatch.deleteMany({
        where: {
          claimId: input.claimId,
          deductionIndex: input.request.deductionIndex,
        },
      });
      // De-dupe additionalBillLineItemIds and strip the primary
      // (defensive — the UI shouldn't include the primary in
      // additionals, but if it does we silently drop the
      // duplicate rather than rejecting with a 422).
      const additionals = Array.from(
        new Set(input.request.additionalBillLineItemIds ?? []),
      ).filter((id) => id !== input.request.billLineItemId);

      const created = await tx.eobLineMatch.create({
        data: {
          tenantId: input.tenantId,
          claimId: input.claimId,
          deductionIndex: input.request.deductionIndex,
          billLineItemId: input.request.billLineItemId,
          isDispute: input.request.isDispute,
          confirmedById: input.actorUserId,
        },
      });
      if (additionals.length > 0) {
        await tx.eobLineMatchItem.createMany({
          data: additionals.map((billLineItemId) => ({
            tenantId: input.tenantId,
            eobLineMatchId: created.id,
            billLineItemId,
          })),
        });
      }
      await this.audit.recordWithTx(tx, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        actorType: 'user',
        action: AuditEvents.TENANT_UPDATED,
        resourceType: 'eob_line_match',
        resourceId: input.claimId,
        after: {
          deductionIndex: input.request.deductionIndex,
          billLineItemId: input.request.billLineItemId,
          additionalCount: additionals.length,
          isDispute: input.request.isDispute,
        },
        ipAddress: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      });
    });
    return this.suggestForClaim(input.tenantId, input.claimId);
  }

  // Phase 2 — clear one confirmation. Idempotent (no-op when no
  // row exists). The pure matcher will then re-auto-suggest.
  async reset(input: ResetInput): Promise<EobLineMatchesResponse> {
    await this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const removed = await tx.eobLineMatch.deleteMany({
        where: { claimId: input.claimId, deductionIndex: input.deductionIndex },
      });
      if (removed.count === 0) return;
      await this.audit.recordWithTx(tx, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        actorType: 'user',
        action: AuditEvents.TENANT_UPDATED,
        resourceType: 'eob_line_match',
        resourceId: input.claimId,
        after: {
          deductionIndex: input.deductionIndex,
          reset: true,
        },
        ipAddress: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      });
    });
    return this.suggestForClaim(input.tenantId, input.claimId);
  }
}
