import {
  type RemittanceBatchResponse,
  type RemittanceRow,
  type RemittanceRowResult,
} from '@claims/contracts';
import { Injectable, Logger } from '@nestjs/common';

import { SettlementService } from './settlement.service';
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
          ...(row.shortPaymentReasons !== undefined
            ? { shortPaymentReasons: row.shortPaymentReasons }
            : {}),
        });
        if (row.bankTxnId !== undefined) {
          // Sprint 5 hardening item: persist bankTxnId on Settlement
          // (needs a schema column). For now, log it so ops can
          // grep + reconcile if a question comes up.
          this.log.log(
            `remittance applied claimRefNum=${row.claimRefNum} bankTxnId=${row.bankTxnId} status=${updated.reconciliationStatus}`,
          );
        }
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
}
