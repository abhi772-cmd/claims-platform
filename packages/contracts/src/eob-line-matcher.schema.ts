import { z } from 'zod';

// EOB-line matcher (Phase 1) — read-side suggestion service that
// maps payer-side deduction lines (Settlement.deductions[]) to
// hospital-side classified bill rows (bill_line_item) for a single
// claim. Purely advisory: the matcher writes nothing. Reviewers
// use the suggestions to spot which deductions the hospital
// classified non-medical itself (alignment) vs which deductions
// the hospital had as medical but the payer stripped (dispute
// candidates).
//
// Phase 2 (not in this slice) will let reviewers confirm a
// suggested match, persist the link, and feed appeal-drafting
// with "here's the line we disagree on."

export const EobMatchConfidenceSchema = z.enum(['high', 'medium', 'low', 'none']);
export type EobMatchConfidence = z.infer<typeof EobMatchConfidenceSchema>;

export const EobMatchSignalSchema = z.enum([
  // Bill line amountPaise === deduction amount. Strongest signal,
  // because payer EOBs typically deduct the exact line value when
  // they're rejecting a specific item.
  'amount_exact',
  // Phase 2 — bill line amountPaise is within ±1% (capped at
  // ±10000 paise / ₹100) of the deduction amount. Catches the
  // common case of payer rounding to nearest 100 / dropping
  // paise. Weaker than amount_exact but still a strong signal.
  'amount_close',
  // Description tokens overlap with the deduction's category/reason
  // text. Jaccard ≥ 0.34 (one shared token out of 5 unique tokens)
  // is "weak"; ≥ 0.5 is "strong" — driving the confidence bucket.
  'token_overlap',
  // Payer category aligns with the hospital's medical flag, e.g.
  // payer says "non_payable_items" and the bill line is medical=false
  // (the hospital already classified it as a strip item).
  'category_alignment',
]);
export type EobMatchSignal = z.infer<typeof EobMatchSignalSchema>;

export const EobLineMatchSchema = z.object({
  // Stable index into the Settlement's deductions[] array. We don't
  // use deduction ids because Settlement.deductions is a JSON blob,
  // not a child table — indices are the only stable handle.
  deductionIndex: z.number().int().nonnegative(),
  // The deduction we matched against, copied flat so callers don't
  // need to also load the settlement to display the suggestion.
  deductionCategory: z.string(),
  deductionAmount: z.number().int().nonnegative(),
  deductionReason: z.string().nullable(),
  // Best-match bill line item id, null when no candidate cleared
  // the confidence floor. Reviewers see those as "no suggestion".
  billLineItemId: z.string().uuid().nullable(),
  billLineDescription: z.string().nullable(),
  billLineAmountPaise: z.number().int().nonnegative().nullable(),
  // True when the matched bill row was hospital-tagged medical and
  // the payer is still deducting it — i.e. a dispute candidate.
  // Null when there's no match.
  isDisputeCandidate: z.boolean().nullable(),
  confidence: EobMatchConfidenceSchema,
  signals: z.array(EobMatchSignalSchema),
  // Phase 2 — true when a reviewer has explicitly confirmed this
  // row (Settlement.deductions[deductionIndex] ↔ billLineItemId).
  // When true, the matcher's auto-suggestion is REPLACED by the
  // reviewer's choice; the row is locked at `high` confidence
  // and `signals[]` is empty (the reviewer's word stands on its
  // own without the heuristic chips).
  confirmed: z.boolean().default(false),
  // Phase 2 — id of the user who confirmed. Null when not
  // confirmed. Surfaced only for audit / hover-tooltip purposes;
  // not used for control flow.
  confirmedById: z.string().uuid().nullable(),
  // Phase 2 — ISO timestamp of the confirmation. Null when not
  // confirmed.
  confirmedAt: z.string().datetime().nullable(),
});
export type EobLineMatch = z.infer<typeof EobLineMatchSchema>;

export const EobLineMatchesResponseSchema = z.object({
  matches: z.array(EobLineMatchSchema),
  // Bill line item ids that are NOT the best match for any
  // deduction. Useful for the reviewer to see "what wasn't
  // deducted" at a glance — usually the medical lines the payer
  // accepted in full.
  unmatchedBillLineIds: z.array(z.string().uuid()),
  // Totals so the UI can show "₹X deducted, ₹Y accounted for"
  // without re-summing.
  totalDeductionAmount: z.number().int().nonnegative(),
  totalMatchedAmount: z.number().int().nonnegative(),
  // Number of dispute candidates (matched rows where the hospital
  // had medical=true but the payer deducted). The settlement
  // panel surfaces this as a tally on the panel header.
  disputeCandidateCount: z.number().int().nonnegative(),
});
export type EobLineMatchesResponse = z.infer<typeof EobLineMatchesResponseSchema>;

// Phase 2 — reviewer confirms (or explicitly clears) a match for
// one deduction. billLineItemId === null means "no bill line
// matches this deduction" — a legitimate finding the reviewer can
// record so the matcher stops re-suggesting against this row.
// isDispute is captured at confirm time from the bill row's
// current `medical` state and stored as a stable fact (does NOT
// drift if the bill row's medical flag later changes).
export const ConfirmEobLineMatchRequestSchema = z.object({
  deductionIndex: z.number().int().nonnegative(),
  billLineItemId: z.string().uuid().nullable(),
  isDispute: z.boolean(),
});
export type ConfirmEobLineMatchRequest = z.infer<
  typeof ConfirmEobLineMatchRequestSchema
>;

