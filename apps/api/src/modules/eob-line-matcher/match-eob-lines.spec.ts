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
    opts: { isDispute?: boolean } = {},
  ): ConfirmedEobLineMatch {
    return {
      deductionIndex,
      billLineItemId,
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
