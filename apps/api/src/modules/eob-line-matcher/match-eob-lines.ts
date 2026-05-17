// EOB-line matcher (Phase 1) — pure suggestion logic.
//
// Given the payer's deductions[] (from Settlement.deductions) and
// the hospital's bill_line_item rows for a single claim, propose
// the most likely bill-line ↔ deduction mapping. NOTHING here
// touches the DB; the wrapping service handles loads + RLS.
//
// Phase 1 is intentionally simple — three independent signals
// (amount-exact, token-overlap, category-alignment) combined into
// a four-bucket confidence (high/medium/low/none). Phase 2 will
// add fuzzy amount tolerance, multi-line matches (one deduction
// fanning out across several bill rows), and reviewer-confirmed
// persistence; that work has no place here yet.

import {
  type BillLineItem,
  type DeductionLine,
  type EobLineMatch,
  type EobMatchConfidence,
  type EobMatchSignal,
} from '@claims/contracts';

// Drop frequent connectives + units. Anything else of length ≥ 3
// survives tokenisation. Tuned against the reference EOB / bill
// samples — "tooth", "room", "rent" all survive; "the", "and",
// "rs" don't.
const STOP_WORDS = new Set<string>([
  'the', 'and', 'for', 'with', 'from', 'into', 'per', 'day',
  'rs', 'inr', 'amount', 'amt', 'qty', 'item', 'items',
  'total', 'gst', 'tax', 'fee', 'fees', 'charge', 'charges',
  'rent', // 'rent' shows up on both sides of every match — kills selectivity
]);

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
    if (raw.length < 3) continue;
    if (STOP_WORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const uni = a.size + b.size - inter;
  return uni > 0 ? inter / uni : 0;
}

// Payer-category → "this deduction is for non-medical line items"
// alignment. Phase 1 only handles the most common case: the payer
// explicitly says non-payable. Other categories (copay, sublimit,
// cap_exceeded) are typically claim-level or sub-limit-level, not
// line-level; we don't try to align them.
function categoryWantsNonMedical(category: string): boolean {
  const c = category.toLowerCase();
  return (
    c === 'non_payable_items' ||
    c === 'non_admissible' ||
    c === 'exclusion' ||
    c.includes('non-payable') ||
    c.includes('non payable')
  );
}

// Score a single (deduction, billLine) pair. Higher = better.
// Tuned so amount-exact always beats pure-token, amount-close
// beats pure-token, but a row with stronger amount signal + token
// agreement beats amount-only (so ties between bill rows with the
// same paise still resolve toward the better description match).
interface ScoreFactors {
  amountExact: boolean;
  // Phase 2 — payer amount within ±1% (cap ±10000 paise / ₹100)
  // of the bill line. Strictly excludes amountExact (a row is
  // either exact OR close, never both).
  amountClose: boolean;
  jaccardScore: number;
  categoryAligns: boolean;
}

// Decide whether two amounts are "close enough" to call it a
// rounding match. Tolerance is min(1% of larger, ₹100). The 1%
// catches small bills where ₹100 would be too generous (e.g. a
// ₹500 toiletry line shouldn't match a ₹600 deduction). The ₹100
// cap stops big bills from accepting noisy matches (a ₹50,000
// surgery should NOT match a ₹50,500 deduction — that's a real
// disagreement).
function isAmountClose(billPaise: number, deductionPaise: number): boolean {
  if (billPaise === deductionPaise) return false; // exact is its own bucket
  const diff = Math.abs(billPaise - deductionPaise);
  const onePercent = Math.round(Math.max(billPaise, deductionPaise) * 0.01);
  const tolerance = Math.min(onePercent, 10_000);
  return diff <= tolerance;
}

function scoreOf(f: ScoreFactors): number {
  let s = 0;
  if (f.amountExact) s += 100;
  else if (f.amountClose) s += 60;
  s += Math.round(f.jaccardScore * 40); // 0..40
  if (f.categoryAligns) s += 5;
  return s;
}

function bucketConfidence(f: ScoreFactors): EobMatchConfidence {
  if (f.amountExact && f.jaccardScore >= 0.34) return 'high';
  if (f.amountExact) return 'medium';
  // amount_close + decent tokens = medium (the rounding-tolerant
  // version of the amount-exact + tokens → high rule).
  if (f.amountClose && f.jaccardScore >= 0.34) return 'medium';
  if (f.amountClose) return 'low';
  if (f.jaccardScore >= 0.5) return 'medium';
  if (f.jaccardScore >= 0.2) return 'low';
  if (f.categoryAligns && f.jaccardScore > 0) return 'low';
  return 'none';
}

// Phase 2 — a reviewer-confirmed mapping for one deduction. The
// matcher consumes these alongside its own suggestions; when a
// deductionIndex appears in `confirmed`, the auto-suggest output
// for that index is REPLACED with the reviewer's word.
export interface ConfirmedEobLineMatch {
  deductionIndex: number;
  billLineItemId: string | null;
  isDispute: boolean;
  confirmedById: string;
  confirmedAt: string;
}

export interface MatchEobLinesInput {
  deductions: ReadonlyArray<DeductionLine>;
  billLines: ReadonlyArray<BillLineItem>;
  // Phase 2 — reviewer confirmations keyed by deductionIndex.
  // Optional for backwards compatibility with Phase 1 callers
  // (specs in particular).
  confirmed?: ReadonlyArray<ConfirmedEobLineMatch>;
}

export interface MatchEobLinesResult {
  matches: EobLineMatch[];
  unmatchedBillLineIds: string[];
  totalDeductionAmount: number;
  totalMatchedAmount: number;
  disputeCandidateCount: number;
}

export function matchEobLines(input: MatchEobLinesInput): MatchEobLinesResult {
  const { deductions, billLines, confirmed } = input;
  const confirmedByIndex = new Map<number, ConfirmedEobLineMatch>();
  for (const c of confirmed ?? []) confirmedByIndex.set(c.deductionIndex, c);
  const billLineById = new Map<string, BillLineItem>();
  for (const b of billLines) billLineById.set(b.id, b);

  // Pre-tokenise once per bill line. Same line is compared against
  // every deduction.
  const billTokens = new Map<string, Set<string>>();
  for (const b of billLines) billTokens.set(b.id, tokenize(b.description));

  const matchedIds = new Set<string>();
  const matches: EobLineMatch[] = [];
  let totalDeductionAmount = 0;
  let totalMatchedAmount = 0;
  let disputeCandidateCount = 0;

  deductions.forEach((d, idx) => {
    totalDeductionAmount += d.amount;

    // Phase 2 — if reviewer confirmed this deduction, the
    // confirmation wins. Auto-suggest is bypassed entirely.
    const confirmedMatch = confirmedByIndex.get(idx);
    if (confirmedMatch !== undefined) {
      const matchedLine =
        confirmedMatch.billLineItemId !== null
          ? billLineById.get(confirmedMatch.billLineItemId) ?? null
          : null;
      if (matchedLine !== null) {
        matchedIds.add(matchedLine.id);
        totalMatchedAmount += d.amount;
      }
      if (confirmedMatch.isDispute) disputeCandidateCount += 1;
      matches.push({
        deductionIndex: idx,
        deductionCategory: d.category,
        deductionAmount: d.amount,
        deductionReason: d.reason ?? null,
        billLineItemId: matchedLine?.id ?? null,
        billLineDescription: matchedLine?.description ?? null,
        billLineAmountPaise: matchedLine?.amountPaise ?? null,
        isDisputeCandidate: matchedLine !== null ? confirmedMatch.isDispute : null,
        // Reviewer's word stands at 'high'; signals stay empty
        // because the heuristic chips aren't what made this row.
        confidence: 'high',
        signals: [],
        confirmed: true,
        confirmedById: confirmedMatch.confirmedById,
        confirmedAt: confirmedMatch.confirmedAt,
      });
      return;
    }

    const reasonTokens = tokenize(`${d.category} ${d.reason ?? ''}`);
    const wantsNonMedical = categoryWantsNonMedical(d.category);

    let best: {
      line: BillLineItem;
      factors: ScoreFactors;
      score: number;
    } | null = null;

    for (const line of billLines) {
      const amountExact = line.amountPaise === d.amount;
      const factors: ScoreFactors = {
        amountExact,
        amountClose: !amountExact && isAmountClose(line.amountPaise, d.amount),
        jaccardScore: jaccard(reasonTokens, billTokens.get(line.id) ?? new Set()),
        categoryAligns: wantsNonMedical && !line.medical,
      };
      const score = scoreOf(factors);
      if (score === 0) continue;
      if (!best || score > best.score) {
        best = { line, factors, score };
      }
    }

    const confidence = best ? bucketConfidence(best.factors) : 'none';
    if (!best || confidence === 'none') {
      matches.push({
        deductionIndex: idx,
        deductionCategory: d.category,
        deductionAmount: d.amount,
        deductionReason: d.reason ?? null,
        billLineItemId: null,
        billLineDescription: null,
        billLineAmountPaise: null,
        isDisputeCandidate: null,
        confidence: 'none',
        signals: [],
        confirmed: false,
        confirmedById: null,
        confirmedAt: null,
      });
      return;
    }

    matchedIds.add(best.line.id);
    totalMatchedAmount += d.amount;

    const signals: EobMatchSignal[] = [];
    if (best.factors.amountExact) signals.push('amount_exact');
    else if (best.factors.amountClose) signals.push('amount_close');
    if (best.factors.jaccardScore > 0) signals.push('token_overlap');
    if (best.factors.categoryAligns) signals.push('category_alignment');

    // Dispute candidate = payer deducted a row the hospital had
    // tagged medical. Reviewer should consider appealing.
    const isDisputeCandidate = best.line.medical === true;
    if (isDisputeCandidate) disputeCandidateCount += 1;

    matches.push({
      deductionIndex: idx,
      deductionCategory: d.category,
      deductionAmount: d.amount,
      deductionReason: d.reason ?? null,
      billLineItemId: best.line.id,
      billLineDescription: best.line.description,
      billLineAmountPaise: best.line.amountPaise,
      isDisputeCandidate,
      confidence,
      signals,
      confirmed: false,
      confirmedById: null,
      confirmedAt: null,
    });
  });

  const unmatchedBillLineIds = billLines
    .filter((b) => !matchedIds.has(b.id))
    .map((b) => b.id);

  return {
    matches,
    unmatchedBillLineIds,
    totalDeductionAmount,
    totalMatchedAmount,
    disputeCandidateCount,
  };
}
