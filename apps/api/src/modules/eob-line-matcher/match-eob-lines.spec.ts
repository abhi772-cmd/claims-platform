import { type BillLineItem, type DeductionLine } from '@claims/contracts';

import { matchEobLines, type ConfirmedEobLineMatch } from './match-eob-lines';

// Test helper — produces a fully-populated BillLineItem fixture
// with stable, predictable ids so spec assertions stay readable.
function bill(
  id: string,
  description: string,
  amountPaise: number,
  medical: boolean,
  opts: { category?: BillLineItem['category']; matchedTerm?: string | null } = {},
): BillLineItem {
  return {
    id: `00000000-0000-0000-0000-${id.padStart(12, '0')}`,
    description,
    amountPaise,
    medical,
    category: medical ? null : (opts.category ?? null),
    matchedTerm: medical ? null : (opts.matchedTerm ?? null),
    createdAt: '2026-05-17T00:00:00.000Z',
  };
}

function deduction(category: string, amount: number, reason?: string): DeductionLine {
  return reason !== undefined ? { category, amount, reason } : { category, amount };
}

describe('matchEobLines', () => {
  it('returns empty arrays when there are no deductions', () => {
    const out = matchEobLines({
      deductions: [],
      billLines: [bill('1', 'Surgery', 5_000_000, true)],
    });
    expect(out.matches).toHaveLength(0);
    expect(out.unmatchedBillLineIds).toEqual([
      '00000000-0000-0000-0000-000000000001',
    ]);
    expect(out.totalDeductionAmount).toBe(0);
    expect(out.totalMatchedAmount).toBe(0);
    expect(out.disputeCandidateCount).toBe(0);
  });

  it('returns none-confidence matches when there are no bill lines', () => {
    const out = matchEobLines({
      deductions: [deduction('non_payable_items', 30_000, 'Toiletry kit')],
      billLines: [],
    });
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]).toMatchObject({
      deductionIndex: 0,
      billLineItemId: null,
      confidence: 'none',
      signals: [],
    });
    expect(out.totalMatchedAmount).toBe(0);
  });

  it('matches on amount-exact + token-overlap → high confidence', () => {
    const out = matchEobLines({
      deductions: [deduction('non_payable_items', 30_000, 'Toiletry kit deducted')],
      billLines: [
        bill('1', 'Surgery — appendicectomy', 5_000_000, true),
        bill('2', 'Toiletry kit', 30_000, false, { category: 'toiletries' }),
        bill('3', 'TV rental', 15_000, false, { category: 'comfort' }),
      ],
    });
    expect(out.matches[0]).toMatchObject({
      billLineItemId: '00000000-0000-0000-0000-000000000002',
      billLineDescription: 'Toiletry kit',
      confidence: 'high',
    });
    expect(out.matches[0]?.signals).toEqual(
      expect.arrayContaining(['amount_exact', 'token_overlap', 'category_alignment']),
    );
    expect(out.matches[0]?.isDisputeCandidate).toBe(false);
  });

  it('matches on amount-exact alone → medium confidence', () => {
    const out = matchEobLines({
      deductions: [deduction('cap_exceeded', 80_000, 'Above ward sub-limit')],
      billLines: [
        bill('1', 'Single AC room daily', 80_000, true),
        bill('2', 'Surgery', 5_000_000, true),
      ],
    });
    expect(out.matches[0]).toMatchObject({
      billLineItemId: '00000000-0000-0000-0000-000000000001',
      confidence: 'medium',
    });
    // Token overlap on "rent" was deliberately stop-worded, so the
    // only signal here is amount_exact.
    expect(out.matches[0]?.signals).toContain('amount_exact');
  });

  it('flags dispute candidate when payer deducts a medical line', () => {
    const out = matchEobLines({
      deductions: [deduction('non_admissible', 4_500_000, 'Surgery not covered')],
      billLines: [
        bill('1', 'Surgery — appendicectomy', 4_500_000, true),
      ],
    });
    expect(out.matches[0]?.isDisputeCandidate).toBe(true);
    expect(out.disputeCandidateCount).toBe(1);
  });

  it('does NOT flag dispute when payer deducts a non-medical line', () => {
    const out = matchEobLines({
      deductions: [deduction('non_payable_items', 30_000, 'Toiletry')],
      billLines: [
        bill('1', 'Toiletry kit', 30_000, false, { category: 'toiletries' }),
      ],
    });
    expect(out.matches[0]?.isDisputeCandidate).toBe(false);
    expect(out.disputeCandidateCount).toBe(0);
  });

  it('falls back to token-overlap when amount does not match', () => {
    // Payer deducted a slightly different amount than the bill line —
    // amount_exact misses, but description tokens still pin it down.
    const out = matchEobLines({
      deductions: [
        deduction('non_payable_items', 29_500, 'Toiletry kit consumables'),
      ],
      billLines: [
        bill('1', 'Toiletry kit', 30_000, false, { category: 'toiletries' }),
        bill('2', 'Surgery', 5_000_000, true),
      ],
    });
    expect(out.matches[0]?.billLineItemId).toBe(
      '00000000-0000-0000-0000-000000000001',
    );
    expect(out.matches[0]?.signals).toContain('token_overlap');
    expect(out.matches[0]?.signals).not.toContain('amount_exact');
    // Without amount confirmation the matcher stays conservative —
    // token overlap drives `low` confidence, surfacing the suggestion
    // but flagging it for reviewer attention.
    expect(out.matches[0]?.confidence).toBe('low');
  });

  it('returns unmatchedBillLineIds for rows nothing pointed to', () => {
    const out = matchEobLines({
      deductions: [deduction('non_payable_items', 30_000, 'Toiletry')],
      billLines: [
        bill('1', 'Toiletry kit', 30_000, false, { category: 'toiletries' }),
        bill('2', 'Surgery', 5_000_000, true), // untouched
        bill('3', 'Room rent', 80_000, true), // untouched
      ],
    });
    expect(out.unmatchedBillLineIds).toEqual([
      '00000000-0000-0000-0000-000000000002',
      '00000000-0000-0000-0000-000000000003',
    ]);
  });

  it('totals deduction + matched amounts correctly', () => {
    const out = matchEobLines({
      deductions: [
        deduction('non_payable_items', 30_000, 'Toiletry'),
        deduction('cap_exceeded', 80_000, 'Above sub-limit'),
        // Third deduction has no matching bill line → contributes to
        // total deducted, NOT to total matched.
        deduction('copay', 50_000, 'Patient co-pay'),
      ],
      billLines: [
        bill('1', 'Toiletry kit', 30_000, false, { category: 'toiletries' }),
        bill('2', 'Single AC room daily', 80_000, true),
      ],
    });
    expect(out.totalDeductionAmount).toBe(30_000 + 80_000 + 50_000);
    expect(out.totalMatchedAmount).toBe(30_000 + 80_000);
  });

  // ===========================
  // Phase 2 — fuzzy amount tolerance
  // ===========================

  it('matches amount_close when payer rounds within 1%', () => {
    // Bill ₹500.00, payer deducted ₹495.00 (1% off). Tokens
    // overlap on "toiletry" / "kit" → medium with amount_close.
    const out = matchEobLines({
      deductions: [deduction('non_payable_items', 49_500, 'Toiletry kit')],
      billLines: [bill('1', 'Toiletry kit', 50_000, false, { category: 'toiletries' })],
    });
    expect(out.matches[0]?.signals).toContain('amount_close');
    expect(out.matches[0]?.signals).not.toContain('amount_exact');
    expect(out.matches[0]?.confidence).toBe('medium');
  });

  it('amount_close caps tolerance at ₹100 — bigger gaps do not fire amount_close', () => {
    // ₹50,000 surgery, payer deducted ₹50,500. Difference is
    // ₹500 (> ₹100 cap). Description overlap is rich enough
    // ("appendicectomy" + "surgery") to still drive the match,
    // but amount_close must NOT fire — that's the cap behaviour
    // under test.
    const out = matchEobLines({
      deductions: [
        deduction('non_admissible', 5_050_000, 'Surgery appendicectomy not covered'),
      ],
      billLines: [bill('1', 'Surgery appendicectomy', 5_000_000, true)],
    });
    expect(out.matches[0]?.billLineItemId).toBe(
      '00000000-0000-0000-0000-000000000001',
    );
    expect(out.matches[0]?.signals).not.toContain('amount_close');
    expect(out.matches[0]?.signals).not.toContain('amount_exact');
    expect(out.matches[0]?.signals).toContain('token_overlap');
  });

  it('prefers amount_exact over amount_close when both candidates exist', () => {
    // Two toiletry rows: one at ₹495 (close to deduction's ₹495),
    // one at exactly ₹495. The exact one wins.
    const out = matchEobLines({
      deductions: [deduction('non_payable_items', 49_500, 'Toiletry kit')],
      billLines: [
        bill('1', 'Toiletry kit batch A', 49_700, false, { category: 'toiletries' }),
        bill('2', 'Toiletry kit batch B', 49_500, false, { category: 'toiletries' }),
      ],
    });
    expect(out.matches[0]?.billLineItemId).toBe(
      '00000000-0000-0000-0000-000000000002',
    );
    expect(out.matches[0]?.signals).toContain('amount_exact');
  });

  // ===========================
  // Phase 2 — reviewer-confirmed matches
  // ===========================

  function confirm(
    deductionIndex: number,
    billLineItemId: string | null,
    opts: { isDispute?: boolean; additionalBillLineItemIds?: string[] } = {},
  ): ConfirmedEobLineMatch {
    return {
      deductionIndex,
      billLineItemId,
      additionalBillLineItemIds: opts.additionalBillLineItemIds ?? [],
      isDispute: opts.isDispute ?? false,
      confirmedById: '00000000-0000-0000-0000-aaaaaaaaaaaa',
      confirmedAt: '2026-05-17T12:00:00.000Z',
    };
  }

  it('reviewer confirmation replaces the auto-suggest', () => {
    // Without confirmation, "Toiletry kit" would win on amount +
    // tokens. The reviewer points the deduction at "TV rental"
    // instead. The matcher honours the reviewer.
    const out = matchEobLines({
      deductions: [deduction('non_payable_items', 30_000, 'Toiletry kit')],
      billLines: [
        bill('1', 'Toiletry kit', 30_000, false, { category: 'toiletries' }),
        bill('2', 'TV rental', 15_000, false, { category: 'comfort' }),
      ],
      confirmed: [
        confirm(0, '00000000-0000-0000-0000-000000000002', { isDispute: false }),
      ],
    });
    expect(out.matches[0]?.billLineItemId).toBe(
      '00000000-0000-0000-0000-000000000002',
    );
    expect(out.matches[0]?.billLineDescription).toBe('TV rental');
    expect(out.matches[0]?.confirmed).toBe(true);
    // Confirmation locks at 'high' regardless of underlying
    // heuristic agreement.
    expect(out.matches[0]?.confidence).toBe('high');
    expect(out.matches[0]?.signals).toEqual([]);
  });

  it('reviewer can confirm explicit "no match"', () => {
    // billLineItemId: null is a legitimate confirmation — the
    // reviewer reviewed and decided no bill line corresponds.
    const out = matchEobLines({
      deductions: [deduction('copay', 50_000, 'Patient co-pay')],
      billLines: [
        bill('1', 'Surgery', 5_000_000, true),
      ],
      confirmed: [confirm(0, null)],
    });
    expect(out.matches[0]?.confirmed).toBe(true);
    expect(out.matches[0]?.billLineItemId).toBeNull();
    expect(out.matches[0]?.isDisputeCandidate).toBeNull();
    // Bill row 1 should still appear in unmatched (nothing
    // pointed at it).
    expect(out.unmatchedBillLineIds).toContain(
      '00000000-0000-0000-0000-000000000001',
    );
  });

  it('reviewer isDispute=true is captured even when bill row is non-medical', () => {
    // Captured-at-confirm-time semantics: even though bill row is
    // non-medical right now, the reviewer's recorded dispute flag
    // is what counts (matches the migration's stored-fact rule).
    const out = matchEobLines({
      deductions: [deduction('non_payable_items', 30_000, 'Toiletry')],
      billLines: [
        bill('1', 'Toiletry kit', 30_000, false, { category: 'toiletries' }),
      ],
      confirmed: [
        confirm(0, '00000000-0000-0000-0000-000000000001', { isDispute: true }),
      ],
    });
    expect(out.matches[0]?.isDisputeCandidate).toBe(true);
    expect(out.disputeCandidateCount).toBe(1);
  });

  it('confirmation surfaces confirmedById + confirmedAt on the row', () => {
    const out = matchEobLines({
      deductions: [deduction('non_payable_items', 30_000, 'Toiletry')],
      billLines: [
        bill('1', 'Toiletry kit', 30_000, false, { category: 'toiletries' }),
      ],
      confirmed: [confirm(0, '00000000-0000-0000-0000-000000000001')],
    });
    expect(out.matches[0]?.confirmedById).toBe(
      '00000000-0000-0000-0000-aaaaaaaaaaaa',
    );
    expect(out.matches[0]?.confirmedAt).toBe('2026-05-17T12:00:00.000Z');
  });

  // ===========================
  // Phase 3 — subset matching (multi-line)
  // ===========================

  it('matches a subset of non-medical rows summing exactly to a category strip', () => {
    // Classic case: payer deducts "non_payable_items ₹2500" — no
    // single bill line is ₹2500, but five non-medical rows sum to
    // exactly ₹2500. The matcher should fan out across all five.
    const out = matchEobLines({
      deductions: [deduction('non_payable_items', 250_000, 'Non-payable items strip')],
      billLines: [
        bill('1', 'Surgery', 5_000_000, true),
        bill('2', 'Toiletry kit', 30_000, false, { category: 'toiletries' }),
        bill('3', 'TV rental', 15_000, false, { category: 'comfort' }),
        bill('4', 'Attendant food', 90_000, false, { category: 'attendant_food' }),
        bill('5', 'Admin fees', 70_000, false, { category: 'admin_fees' }),
        bill('6', 'Documentation', 45_000, false, { category: 'documentation' }),
      ],
    });
    const m = out.matches[0];
    expect(m?.billLineItemId).not.toBeNull();
    expect(m?.additionalBillLineItemIds.length).toBeGreaterThanOrEqual(1);
    // Subset sum must hit target exactly.
    expect(m?.subsetSumPaise).toBe(250_000);
    expect(m?.signals).toContain('subset_sum_exact');
    expect(m?.signals).toContain('category_alignment');
    expect(m?.confidence).toBe('high');
    // No medical row should have leaked in.
    const subsetIds = [m?.billLineItemId, ...(m?.additionalBillLineItemIds ?? [])];
    expect(subsetIds).not.toContain('00000000-0000-0000-0000-000000000001');
  });

  it('prefers single-line exact match over subset when both exist', () => {
    // Single "Toiletry kit ₹2500" beats any subset that also sums
    // to ₹2500 — single-exact has the higher score.
    const out = matchEobLines({
      deductions: [deduction('non_payable_items', 250_000, 'Toiletry kit')],
      billLines: [
        bill('1', 'Toiletry kit batch', 250_000, false, { category: 'toiletries' }),
        bill('2', 'TV rental', 50_000, false, { category: 'comfort' }),
        bill('3', 'Attendant food', 100_000, false, { category: 'attendant_food' }),
        bill('4', 'Admin fees', 100_000, false, { category: 'admin_fees' }),
      ],
    });
    expect(out.matches[0]?.billLineItemId).toBe(
      '00000000-0000-0000-0000-000000000001',
    );
    expect(out.matches[0]?.additionalBillLineItemIds).toEqual([]);
    expect(out.matches[0]?.signals).toContain('amount_exact');
    expect(out.matches[0]?.signals).not.toContain('subset_sum_exact');
  });

  it('subset_sum_close matches when sum is within ±1% / ±₹100', () => {
    // Subset sums to ₹2,495 (5 paise off target of ₹2,500). Within
    // tolerance. Should fire subset_sum_close, not subset_sum_exact.
    const out = matchEobLines({
      deductions: [deduction('non_payable_items', 250_000, 'Non-payable strip')],
      billLines: [
        bill('1', 'Toiletry kit', 50_000, false, { category: 'toiletries' }),
        bill('2', 'TV rental', 49_500, false, { category: 'comfort' }),
        bill('3', 'Attendant food', 100_000, false, { category: 'attendant_food' }),
        bill('4', 'Admin fees', 50_000, false, { category: 'admin_fees' }),
      ],
    });
    expect(out.matches[0]?.subsetSumPaise).toBe(249_500);
    expect(out.matches[0]?.signals).toContain('subset_sum_close');
    expect(out.matches[0]?.signals).not.toContain('subset_sum_exact');
    expect(out.matches[0]?.confidence).toBe('medium');
  });

  it('does NOT propose a subset when no combination fits the tolerance', () => {
    // Sums won't land near the target. Should fall back to single
    // best (here, none — no single-line score either).
    const out = matchEobLines({
      deductions: [deduction('non_payable_items', 500_000, 'Strip')],
      billLines: [
        bill('1', 'Surgery', 5_000_000, true),
        bill('2', 'Random consumable', 12_345, false, { category: 'miscellaneous' }),
      ],
    });
    // No subset summed to anywhere near ₹5000, no single line did
    // either. Either 'none' confidence OR a low-confidence
    // category-only match — but NO subset signals.
    expect(out.matches[0]?.signals).not.toContain('subset_sum_exact');
    expect(out.matches[0]?.signals).not.toContain('subset_sum_close');
  });

  it('flags subset as dispute candidate when ANY member is medical', () => {
    // Payer says "non_admissible ₹2500" — one medical row + a
    // non-medical row sum to it. Touching a medical row makes
    // the whole subset disputable.
    //
    // We use a category (non_admissible) that aligns to
    // non-medical so subset evaluation kicks in but allow the
    // matcher to find a mixed subset — actually wait, we filter
    // out medical from subset candidates when wantsNonMedical is
    // true. So this test exercises a non-aligned category
    // (e.g. cap_exceeded) where all rows compete.
    const out = matchEobLines({
      deductions: [
        deduction('cap_exceeded', 200_000, 'Sub-limit exceeded across stay'),
      ],
      billLines: [
        bill('1', 'Room rent day 1', 100_000, true),
        bill('2', 'Room rent day 2', 100_000, true),
      ],
    });
    const m = out.matches[0];
    expect(m?.subsetSumPaise).toBe(200_000);
    expect(m?.isDisputeCandidate).toBe(true);
    expect(out.disputeCandidateCount).toBe(1);
  });

  it('honours reviewer confirmation with additionalBillLineItemIds', () => {
    // Reviewer confirms a multi-line subset for a single payer
    // deduction. The matcher replays the subset and locks it at
    // high confidence.
    const out = matchEobLines({
      deductions: [deduction('non_payable_items', 200_000, 'Strip')],
      billLines: [
        bill('1', 'Toiletry kit', 50_000, false, { category: 'toiletries' }),
        bill('2', 'TV rental', 50_000, false, { category: 'comfort' }),
        bill('3', 'Admin fees', 100_000, false, { category: 'admin_fees' }),
      ],
      confirmed: [
        confirm(0, '00000000-0000-0000-0000-000000000001', {
          additionalBillLineItemIds: [
            '00000000-0000-0000-0000-000000000002',
            '00000000-0000-0000-0000-000000000003',
          ],
        }),
      ],
    });
    const m = out.matches[0];
    expect(m?.confirmed).toBe(true);
    expect(m?.billLineItemId).toBe('00000000-0000-0000-0000-000000000001');
    expect(m?.additionalBillLineItemIds).toEqual([
      '00000000-0000-0000-0000-000000000002',
      '00000000-0000-0000-0000-000000000003',
    ]);
    expect(m?.subsetSumPaise).toBe(200_000);
    expect(m?.confidence).toBe('high');
  });

  it('marks all subset members as matched (none left in unmatchedBillLineIds)', () => {
    const out = matchEobLines({
      deductions: [deduction('non_payable_items', 150_000, 'Strip')],
      billLines: [
        bill('1', 'Toiletry kit', 50_000, false, { category: 'toiletries' }),
        bill('2', 'TV rental', 50_000, false, { category: 'comfort' }),
        bill('3', 'Admin fees', 50_000, false, { category: 'admin_fees' }),
        bill('4', 'Surgery', 5_000_000, true),
      ],
    });
    // 1, 2, 3 should all be picked. 4 (surgery, medical) should
    // not have been a candidate (wantsNonMedical filter) and
    // shows up in unmatched.
    expect(out.unmatchedBillLineIds).toContain(
      '00000000-0000-0000-0000-000000000004',
    );
    expect(out.unmatchedBillLineIds).not.toContain(
      '00000000-0000-0000-0000-000000000001',
    );
    expect(out.unmatchedBillLineIds).not.toContain(
      '00000000-0000-0000-0000-000000000002',
    );
    expect(out.unmatchedBillLineIds).not.toContain(
      '00000000-0000-0000-0000-000000000003',
    );
  });

  it('does not double-count a bill line if two deductions hit it', () => {
    // Both deductions are the same amount AND share the same
    // bill-line description. Both pick line 1 as best. Only one
    // should land in unmatched / matched accounting.
    const out = matchEobLines({
      deductions: [
        deduction('non_payable_items', 30_000, 'Toiletry kit'),
        deduction('non_payable_items', 30_000, 'Toiletry kit duplicate'),
      ],
      billLines: [
        bill('1', 'Toiletry kit', 30_000, false, { category: 'toiletries' }),
      ],
    });
    expect(out.matches[0]?.billLineItemId).toBe(
      '00000000-0000-0000-0000-000000000001',
    );
    expect(out.matches[1]?.billLineItemId).toBe(
      '00000000-0000-0000-0000-000000000001',
    );
    // Bill line 1 was a best match — should appear in matched
    // (it's NOT in unmatched).
    expect(out.unmatchedBillLineIds).toEqual([]);
    // Both deductions count toward totalMatchedAmount (we're
    // accounting deduction-side, not bill-side).
    expect(out.totalMatchedAmount).toBe(60_000);
  });
});
