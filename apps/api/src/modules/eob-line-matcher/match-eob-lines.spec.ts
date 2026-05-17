import { type BillLineItem, type DeductionLine } from '@claims/contracts';

import { matchEobLines } from './match-eob-lines';

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
