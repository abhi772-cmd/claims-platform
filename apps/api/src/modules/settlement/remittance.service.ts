import {
  type LumpSumAllocateResponse,
  type LumpSumAllocateResult,
  type LumpSumAllocation,
  type RemittanceBatchResponse,
  type RemittanceCandidate,
  type RemittanceRow,
  type RemittanceRowResult,
} from '@claims/contracts';
import { Injectable, Logger } from '@nestjs/common';

import { SettlementService } from './settlement.service';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { PrismaService } from '../../common/prisma/prisma.service';

export interface ProcessBatchInput {
  tenantId: string;
  actorUserId: string;
  rows: RemittanceRow[];
}

// Slice AL — bulk remittance reconciliation. Operators receive
// remittance files from payers (CSV / Excel exported from the
// bank) and POST the parsed rows here. We match each row to a
// Settlement by Claim.claimRefNum within the tenant and apply
// receipts via the existing SettlementService.recordReceipt path
// so the state-machine + ledger semantics stay identical to the
// per-claim flow.
//
// Per-row outcomes are returned so the operator UI can show a
// summary (X applied, Y unmatched, Z failed) without making a
// follow-up request per row. Failures don't roll back the batch —
// applied rows stay applied.
//
// Matching is exact on claimRefNum. Fuzzy / partial matching is a
// Sprint 5+ hardening item; in practice payers are deterministic
// about ref numbers so the strict match is what ops want.
@Injectable()
export class RemittanceService {
  private readonly log = new Logger(RemittanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settlement: SettlementService,
  ) {}

  async processBatch(input: ProcessBatchInput): Promise<RemittanceBatchResponse> {
    const results: RemittanceRowResult[] = [];

    // Look up all claimIds matching the row's claimRefNums in one
    // query. The tenant-context tx ensures RLS confines the lookup
    // to this tenant's claims; cross-tenant ref-num collisions
    // can't leak.
    const refNums = Array.from(new Set(input.rows.map((r) => r.claimRefNum)));
    const claimByRef = await this.prisma.runInTenantContext(
      input.tenantId,
      'tenant',
      async (tx) => {
        const rows = await tx.claim.findMany({
          where: { claimRefNum: { in: refNums } },
          select: { id: true, claimRefNum: true },
        });
        const map = new Map<string, string>();
        for (const r of rows) {
          if (r.claimRefNum !== null) map.set(r.claimRefNum, r.id);
        }
        return map;
      },
    );

    for (const row of input.rows) {
      const claimId = claimByRef.get(row.claimRefNum);
      if (!claimId) {
        results.push({
          claimRefNum: row.claimRefNum,
          outcome: 'unmatched_no_claim',
        });
        continue;
      }

      // Settlement might not exist yet (claim never had /expect
      // called). We could auto-/expect here, but that would silently
      // adopt a paymentMode and expectedAmount the operator didn't
      // confirm. Surface as unmatched so the operator runs /expect
      // explicitly.
      const settlement = await this.settlement.getByClaim(input.tenantId, claimId);
      if (!settlement) {
        results.push({
          claimRefNum: row.claimRefNum,
          outcome: 'unmatched_no_settlement',
        });
        continue;
      }

      try {
        const updated = await this.settlement.recordReceipt({
          tenantId: input.tenantId,
          claimId,
          actorUserId: input.actorUserId,
          receivedAmount: row.receivedAmount,
          ...(row.receivedAt !== undefined ? { receivedAt: new Date(row.receivedAt) } : {}),
          ...(row.bankTxnId !== undefined ? { bankTxnId: row.bankTxnId } : {}),
          ...(row.shortPaymentReasons !== undefined
            ? { shortPaymentReasons: row.shortPaymentReasons }
            : {}),
        });
        results.push({
          claimRefNum: row.claimRefNum,
          outcome: 'applied',
          reconciliationStatus: updated.reconciliationStatus,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn(
          `remittance row failed claimRefNum=${row.claimRefNum} err=${message}`,
        );
        results.push({
          claimRefNum: row.claimRefNum,
          outcome: 'failed',
          error: message.slice(0, 500),
        });
      }
    }

    const applied = results.filter((r) => r.outcome === 'applied').length;
    const unmatched = results.filter(
      (r) => r.outcome === 'unmatched_no_claim' || r.outcome === 'unmatched_no_settlement',
    ).length;
    const failed = results.filter((r) => r.outcome === 'failed').length;

    return {
      totalRows: results.length,
      appliedCount: applied,
      unmatchedCount: unmatched,
      failedCount: failed,
      results,
    };
  }

  // T3-2 — lump-sum candidate suggestion. Returns open Settlement rows
  // (no receipt yet) that match the optional payerCode filter, ordered
  // by expectedAmount descending so the operator can spot the biggest
  // candidates first. The total amount is informational — we DON'T
  // pre-filter on it here because partial-pay scenarios mean a single
  // open settlement may receive less than its expectedAmount, and the
  // operator should still see it as a candidate.
  async proposeCandidates(input: {
    tenantId: string;
    payerCode?: string;
    limit?: number;
  }): Promise<{ candidates: RemittanceCandidate[] }> {
    const limit = Math.min(input.limit ?? 50, 200);

    return this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const settlements = await tx.settlement.findMany({
        where: {
          tenantId: input.tenantId,
          // "manual_match_pending" is the post-/expect, pre-receipt
          // state — exactly the rows lump-sum allocations target.
          // We also include "short_paid" since a partial receipt
          // could be topped up by a subsequent UTR.
          reconciliationStatus: { in: ['manual_match_pending', 'short_paid'] },
        },
        orderBy: { expectedAmount: 'desc' },
        take: limit,
      });

      if (settlements.length === 0) return { candidates: [] };

      const claimIds = settlements.map((s) => s.claimId);
      const claims = await tx.claim.findMany({
        where: { id: { in: claimIds } },
        select: {
          id: true,
          claimRefNum: true,
          payerCode: true,
          caseId: true,
        },
      });
      const caseIds = Array.from(new Set(claims.map((c) => c.caseId)));
      const cases = await tx.case.findMany({
        where: { id: { in: caseIds } },
        select: { id: true, patientName: true },
      });
      const claimById = new Map(claims.map((c) => [c.id, c]));
      const caseById = new Map(cases.map((c) => [c.id, c]));

      // Apply optional payerCode filter post-join (Prisma can't span
      // the join cleanly in a single query without raw SQL, and the
      // settlement table doesn't denormalise payerCode).
      const candidates: RemittanceCandidate[] = [];
      for (const s of settlements) {
        const claim = claimById.get(s.claimId);
        if (!claim) continue;
        if (input.payerCode && claim.payerCode !== input.payerCode) continue;
        const c = caseById.get(claim.caseId);
        candidates.push({
          claimId: s.claimId,
          claimRefNum: claim.claimRefNum,
          patientName: c?.patientName ?? '',
          payerCode: claim.payerCode,
          expectedAmount: s.expectedAmount,
          currentReceivedAmount: s.receivedAmount,
          reconciliationStatus: s.reconciliationStatus,
        });
      }
      return { candidates };
    });
  }

  // T3-2 — atomic lump-sum allocation. Validates the sum of per-claim
  // amounts equals the bank's total, then applies each allocation
  // through SettlementService.recordReceipt with a shared bankTxnId
  // so the existing state-machine + audit trail handle the heavy
  // lifting. Failed per-claim legs DON'T roll back applied legs —
  // mirrors processBatch semantics so a single bad claimId doesn't
  // strand a 199-claim allocation.
  async allocateLumpSum(input: {
    tenantId: string;
    actorUserId: string;
    bankTxnId: string;
    totalAmount: number;
    receivedAt?: Date;
    payerCode?: string;
    allocations: LumpSumAllocation[];
  }): Promise<LumpSumAllocateResponse> {
    // 1. Variance check — must be exact to the paise.
    const sum = input.allocations.reduce((acc, a) => acc + a.allocatedAmount, 0);
    if (sum !== input.totalAmount) {
      throw new ValidationFailedError({
        allocations: [
          `Sum of allocations (${sum}) does not equal totalAmount (${input.totalAmount}).`,
        ],
      });
    }

    // 2. Duplicate-UTR guard — if any Settlement row in this tenant
    // already carries this bankTxnId, refuse. Operators re-running an
    // accidental duplicate should clear the prior allocation manually.
    const alreadyUsed = await this.prisma.runInTenantContext(
      input.tenantId,
      'tenant',
      async (tx) => {
        const existing = await tx.settlement.findFirst({
          where: { tenantId: input.tenantId, bankTxnId: input.bankTxnId },
          select: { id: true },
        });
        return existing !== null;
      },
    );
    if (alreadyUsed) {
      throw new ValidationFailedError({
        bankTxnId: [
          `bankTxnId "${input.bankTxnId}" already applied. Clear the prior allocation before re-running.`,
        ],
      });
    }

    // 3. Apply per-claim — reuse the existing recordReceipt path.
    const results: LumpSumAllocateResult[] = [];
    let appliedCount = 0;
    let failedCount = 0;
    let allocatedTotal = 0;

    for (const a of input.allocations) {
      try {
        const updated = await this.settlement.recordReceipt({
          tenantId: input.tenantId,
          claimId: a.claimId,
          actorUserId: input.actorUserId,
          receivedAmount: a.allocatedAmount,
          ...(input.receivedAt !== undefined ? { receivedAt: input.receivedAt } : {}),
          bankTxnId: input.bankTxnId,
        });
        results.push({
          claimId: a.claimId,
          allocatedAmount: a.allocatedAmount,
          outcome: 'applied',
          reconciliationStatus: updated.reconciliationStatus,
        });
        appliedCount += 1;
        allocatedTotal += a.allocatedAmount;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn(
          `lump-sum allocation row failed claimId=${a.claimId} amount=${a.allocatedAmount} err=${message}`,
        );
        results.push({
          claimId: a.claimId,
          allocatedAmount: a.allocatedAmount,
          outcome: 'failed',
          error: message.slice(0, 500),
        });
        failedCount += 1;
      }
    }

    return {
      bankTxnId: input.bankTxnId,
      totalAmount: input.totalAmount,
      allocatedTotal,
      appliedCount,
      failedCount,
      results,
    };
  }
}
