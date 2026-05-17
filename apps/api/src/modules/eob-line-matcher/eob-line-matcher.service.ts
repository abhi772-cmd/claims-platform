// EOB-line matcher (Phase 1) — service layer.
//
// Loads the inputs (Settlement.deductions + bill_line_item rows)
// for one claim, hands them to the pure matcher, and returns the
// suggestion bundle. Read-only — no DB writes here.

import { type EobLineMatchesResponse } from '@claims/contracts';
import { Injectable } from '@nestjs/common';

import { matchEobLines } from './match-eob-lines';
import { BillLineItemService } from '../bill-line-item/bill-line-item.service';
import { SettlementService } from '../settlement/settlement.service';

@Injectable()
export class EobLineMatcherService {
  constructor(
    private readonly billLines: BillLineItemService,
    private readonly settlements: SettlementService,
  ) {}

  async suggestForClaim(
    tenantId: string,
    claimId: string,
  ): Promise<EobLineMatchesResponse> {
    // Parallel reads — both go through their own tenant context.
    // No cross-table tx needed; this is a read-only suggest.
    const [settlement, billLinesResp] = await Promise.all([
      this.settlements.getByClaim(tenantId, claimId),
      this.billLines.listForClaim(tenantId, claimId),
    ]);

    const deductions = settlement?.deductions ?? [];

    const result = matchEobLines({
      deductions,
      billLines: billLinesResp.lines,
    });

    return {
      matches: result.matches,
      unmatchedBillLineIds: result.unmatchedBillLineIds,
      totalDeductionAmount: result.totalDeductionAmount,
      totalMatchedAmount: result.totalMatchedAmount,
      disputeCandidateCount: result.disputeCandidateCount,
    };
  }
}
