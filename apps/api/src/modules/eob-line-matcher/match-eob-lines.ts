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
  // Phase 3 — subset of bill lines sums exactly to deduction.
  // Mutually exclusive with subsetSumClose.
  subsetSumExact: boolean;
  // Phase 3 — subset sums within tolerance but not exactly.
  subsetSumClose: boolean;
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

// Same tolerance rule, for subset sums. Separate function only to
// keep the call sites readable.
function isSumClose(subsetSum: number, deductionPaise: number): boolean {
  return isAmountClose(subsetSum, deductionPaise);
}

// Phase 3 — bounded subset-sum search.
//
// Returns the best subset (size ≥ 2) of `candidates` whose
// summed amountPaise lands closest to `targetPaise` — exact if
// possible, else within the same ±1% / ±₹100 tolerance as
// isAmountClose. Returns null when no qualifying subset exists.
//
// Complexity: typical Indian bill has 5-30 rows; we cap depth at
// MAX_SUBSET_DEPTH (6 by default — covers all real category-strip
// cases observed in payer EOBs) and prune aggressively. Candidates
// are pre-sorted ascending so once `sumSoFar + smallestRemaining >
// targetPaise + tolerance`, we can break.
const MAX_SUBSET_DEPTH = 6;

interface SubsetResult {
  lines: BillLineItem[];
  sumPaise: number;
  exact: boolean;
}

function findBestSubset(
  candidates: ReadonlyArray<BillLineItem>,
  targetPaise: number,
): SubsetResult | null {
  if (candidates.length < 2 || targetPaise <= 0) return null;

  // Sort ascending by amount — lets us short-circuit when even
  // adding the smallest remaining candidate would exceed the
  // target + tolerance.
  const sorted = [...candidates].sort((a, b) => a.amountPaise - b.amountPaise);
  const tolerance = Math.min(Math.round(targetPaise * 0.01), 10_000);
  const upperBound = targetPaise + tolerance;

  let best: SubsetResult | null = null;
  let bestGap = tolerance + 1;
  const current: BillLineItem[] = [];

  function search(start: number, sumSoFar: number): void {
    if (current.length >= 2) {
      const gap = Math.abs(sumSoFar - targetPaise);
      if (gap <= tolerance && gap < bestGap) {
        bestGap = gap;
        best = {
          lines: [...current],
          sumPaise: sumSoFar,
          exact: sumSoFar === targetPaise,
        };
        // Can't beat exact — short-circuit further search.
        if (gap === 0) return;
      }
    }
    if (current.length >= MAX_SUBSET_DEPTH) return;

    for (let i = start; i < sorted.length; i++) {
      const next = sorted[i];
      if (next === undefined) continue;
      const newSum = sumSoFar + next.amountPaise;
      // Prune: rest is sorted ascending, so if THIS doesn't fit,
      // none of the larger ones will either.
      if (newSum > upperBound) break;
      current.push(next);
      search(i + 1, newSum);
      current.pop();
      if (best !== null && bestGap === 0) return;
    }
  }
  search(0, 0);
  return best;
}

function scoreOf(f: ScoreFactors): number {
  let s = 0;
  // Amount signals are mutually exclusive — at most one fires.
  if (f.amountExact) s += 100;
  else if (f.subsetSumExact) s += 85;
  else if (f.amountClose) s += 60;
  else if (f.subsetSumClose) s += 50;
  s += Math.round(f.jaccardScore * 40); // 0..40
  if (f.categoryAligns) s += 5;
  return s;
}

function bucketConfidence(f: ScoreFactors): EobMatchConfidence {
  // Single-line, exact amount — strongest match.
  if (f.amountExact && f.jaccardScore >= 0.34) return 'high';
  if (f.amountExact) return 'medium';
  // Phase 3 — subset_sum_exact + category alignment is the
  // category-strip case ("non_payable_items: ₹2,500" mapping to
  // 5 non-medical rows summing to ₹2,500). Category alignment is
  // strong for subset matches because the payer is grouping by
  // category.
  if (f.subsetSumExact && f.categoryAligns) return 'high';
  if (f.subsetSumExact) return 'medium';
  // amount_close + decent tokens = medium (the rounding-tolerant
  // version of the amount-exact + tokens → high rule).
  if (f.amountClose && f.jaccardScore >= 0.34) return 'medium';
  if (f.amountClose) return 'low';
  // Phase 3 — subset_sum_close is the rounding-tolerant version
  // of subset_sum_exact. Same ladder as single-line close.
  if (f.subsetSumClose && f.categoryAligns) return 'medium';
  if (f.subsetSumClose) return 'low';
  if (f.jaccardScore >= 0.5) return 'medium';
  if (f.jaccardScore >= 0.2) return 'low';
  if (f.categoryAligns && f.jaccardScore > 0) return 'low';
  return 'none';
}

// Phase 2 — a reviewer-confirmed mapping for one deduction. The
// matcher consumes these alongside its own suggestions; when a
// deductionIndex appears in `confirmed`, the auto-suggest output
// for that index is REPLACED with the reviewer's word.
//
// Phase 3 — `additionalBillLineItemIds` carries subset members
// beyond the primary `billLineItemId`. Empty for single-line
// confirmations; populated for multi-line subsets.
export interface ConfirmedEobLineMatch {
  deductionIndex: number;
  billLineItemId: string | null;
  additionalBillLineItemIds: string[];
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

    // Phase 2/3 — if reviewer confirmed this deduction, the
    // confirmation wins. Auto-suggest is bypassed entirely.
    const confirmedMatch = confirmedByIndex.get(idx);
    if (confirmedMatch !== undefined) {
      const primary =
        confirmedMatch.billLineItemId !== null
          ? billLineById.get(confirmedMatch.billLineItemId) ?? null
          : null;
      const additionals = confirmedMatch.additionalBillLineItemIds
        .map((id) => billLineById.get(id))
        .filter((b): b is BillLineItem => b !== undefined);
      if (primary !== null) {
        matchedIds.add(primary.id);
        for (const a of additionals) matchedIds.add(a.id);
        totalMatchedAmount += d.amount;
      }
      if (confirmedMatch.isDispute) disputeCandidateCount += 1;
      const subsetSum =
        primary !== null
          ? primary.amountPaise + additionals.reduce((s, a) => s + a.amountPaise, 0)
          : null;
      matches.push({
        deductionIndex: idx,
        deductionCategory: d.category,
        deductionAmount: d.amount,
        deductionReason: d.reason ?? null,
        billLineItemId: primary?.id ?? null,
        billLineDescription: primary?.description ?? null,
        billLineAmountPaise: primary?.amountPaise ?? null,
        additionalBillLineItemIds: additionals.map((a) => a.id),
        additionalBillLineDescriptions: additionals.map((a) => a.description),
        additionalBillLineAmountsPaise: additionals.map((a) => a.amountPaise),
        subsetSumPaise: subsetSum,
        isDisputeCandidate: primary !== null ? confirmedMatch.isDispute : null,
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

    // --- Single-line evaluation ---
    let bestSingle: {
      line: BillLineItem;
      factors: ScoreFactors;
      score: number;
    } | null = null;
    for (const line of billLines) {
      const amountExact = line.amountPaise === d.amount;
      const factors: ScoreFactors = {
        amountExact,
        amountClose: !amountExact && isAmountClose(line.amountPaise, d.amount),
        subsetSumExact: false,
        subsetSumClose: false,
        jaccardScore: jaccard(reasonTokens, billTokens.get(line.id) ?? new Set()),
        categoryAligns: wantsNonMedical && !line.medical,
      };
      const score = scoreOf(factors);
      if (score === 0) continue;
      if (!bestSingle || score > bestSingle.score) {
        bestSingle = { line, factors, score };
      }
    }

    // --- Phase 3 — subset evaluation ---
    //
    // Pre-filter candidates: if the payer category wants
    // non-medical, only consider non-medical bill rows for the
    // subset; conversely, never let medical rows leak into a
    // "non-payable items" subset where they don't belong. For
    // payer categories that don't have an obvious medical/non-
    // medical alignment (e.g. cap_exceeded), we let all rows
    // compete on amount alone.
    const subsetCandidates = wantsNonMedical
      ? billLines.filter((b) => !b.medical)
      : billLines;
    const subset = findBestSubset(subsetCandidates, d.amount);
    let bestSubset: {
      primary: BillLineItem;
      additionals: BillLineItem[];
      factors: ScoreFactors;
      score: number;
      subsetSum: number;
    } | null = null;
    if (subset !== null) {
      // Subset-level jaccard = max token overlap among members.
      // Doesn't dominate scoring (subset is mostly about amount
      // alignment + category), but gives a small boost when one
      // member also matches reason tokens.
      let maxJaccard = 0;
      for (const l of subset.lines) {
        const j = jaccard(reasonTokens, billTokens.get(l.id) ?? new Set());
        if (j > maxJaccard) maxJaccard = j;
      }
      const allCategoryAlign =
        wantsNonMedical && subset.lines.every((l) => !l.medical);
      const factors: ScoreFactors = {
        amountExact: false,
        amountClose: false,
        subsetSumExact: subset.exact,
        subsetSumClose: !subset.exact && isSumClose(subset.sumPaise, d.amount),
        jaccardScore: maxJaccard,
        categoryAligns: allCategoryAlign,
      };
      const score = scoreOf(factors);
      // Subset is only meaningfully a subset if size ≥ 2.
      // findBestSubset already enforces that, defensive check.
      if (subset.lines.length >= 2 && score > 0) {
        const primary = subset.lines[0];
        if (primary !== undefined) {
          bestSubset = {
            primary,
            additionals: subset.lines.slice(1),
            factors,
            score,
            subsetSum: subset.sumPaise,
          };
        }
      }
    }

    // --- Pick the winner ---
    // Prefer the higher score. When neither beats zero, fall
    // through to "no match".
    const singleScore = bestSingle?.score ?? 0;
    const subsetScore = bestSubset?.score ?? 0;
    const winner = subsetScore > singleScore ? 'subset' : 'single';

    const chosen =
      winner === 'subset' && bestSubset !== null
        ? {
            primary: bestSubset.primary,
            additionals: bestSubset.additionals,
            factors: bestSubset.factors,
            subsetSum: bestSubset.subsetSum,
          }
        : bestSingle !== null
          ? {
              primary: bestSingle.line,
              additionals: [] as BillLineItem[],
              factors: bestSingle.factors,
              subsetSum: bestSingle.line.amountPaise,
            }
          : null;

    const confidence = chosen ? bucketConfidence(chosen.factors) : 'none';
    if (!chosen || confidence === 'none') {
      matches.push({
        deductionIndex: idx,
        deductionCategory: d.category,
        deductionAmount: d.amount,
        deductionReason: d.reason ?? null,
        billLineItemId: null,
        billLineDescription: null,
        billLineAmountPaise: null,
        additionalBillLineItemIds: [],
        additionalBillLineDescriptions: [],
        additionalBillLineAmountsPaise: [],
        subsetSumPaise: null,
        isDisputeCandidate: null,
        confidence: 'none',
        signals: [],
        confirmed: false,
        confirmedById: null,
        confirmedAt: null,
      });
      return;
    }

    matchedIds.add(chosen.primary.id);
    for (const a of chosen.additionals) matchedIds.add(a.id);
    totalMatchedAmount += d.amount;

    const signals: EobMatchSignal[] = [];
    if (chosen.factors.amountExact) signals.push('amount_exact');
    else if (chosen.factors.amountClose) signals.push('amount_close');
    else if (chosen.factors.subsetSumExact) signals.push('subset_sum_exact');
    else if (chosen.factors.subsetSumClose) signals.push('subset_sum_close');
    if (chosen.factors.jaccardScore > 0) signals.push('token_overlap');
    if (chosen.factors.categoryAligns) signals.push('category_alignment');

    // Dispute candidate semantics for subsets: true if ANY subset
    // member is medical. Reviewer should consider appealing the
    // whole deduction because the payer's strip touched at least
    // one item the hospital tagged medical.
    const allLines = [chosen.primary, ...chosen.additionals];
    const isDisputeCandidate = allLines.some((l) => l.medical === true);
    if (isDisputeCandidate) disputeCandidateCount += 1;

    matches.push({
      deductionIndex: idx,
      deductionCategory: d.category,
      deductionAmount: d.amount,
      deductionReason: d.reason ?? null,
      billLineItemId: chosen.primary.id,
      billLineDescription: chosen.primary.description,
      billLineAmountPaise: chosen.primary.amountPaise,
      additionalBillLineItemIds: chosen.additionals.map((a) => a.id),
      additionalBillLineDescriptions: chosen.additionals.map((a) => a.description),
      additionalBillLineAmountsPaise: chosen.additionals.map((a) => a.amountPaise),
      subsetSumPaise: chosen.subsetSum,
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
