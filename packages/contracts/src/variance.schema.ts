import { z } from 'zod';

// T3-1 — CFO variance dashboard.
//
// Three read-only aggregations over the tenant's Claim + Settlement
// rows. No new tables; pure roll-ups over existing materialised state.
//
//   1. /analytics/variance/summary — top-line KPIs:
//      totalBilled, totalApproved, totalPaid, totalVariance,
//      totalShortPay, plus aging-bucket counts/values for unsettled
//      claims.
//
//   2. /analytics/variance/by-payer?limit=N — top N payers by
//      absolute variance amount (billed − approved), with
//      variance % and count.
//
//   3. /analytics/variance/claims?bucket=&payerCode=&limit= —
//      drill-down list of individual claims feeding the rolled-up
//      tiles. Used when the operator clicks an aging bucket or a
//      payer row on the dashboard.
//
// "Variance" definitions (paise everywhere):
//   billedVariance   = claim.claimAmount   − claim.approvedAmount
//                      (positive ⇒ payer cut some of what we billed)
//   shortPayVariance = claim.approvedAmount − claim.paidAmount
//                      (positive ⇒ bank paid less than approved)
//   netLeakage       = billedVariance + shortPayVariance
//                      (what we lost across both gates)
//
// Aging buckets are calendar-day windows from claim.submittedAt to
// the report time; "unsettled" means status ∈ {PAYMENT_PENDING,
// PAYMENT_RECEIVED, PAYMENT_SHORT_PAID}.

export const VarianceAgingBucketSchema = z.enum([
  'd0_7', // 0-7 days
  'd8_14',
  'd15_30',
  'd31_plus',
]);
export type VarianceAgingBucket = z.infer<typeof VarianceAgingBucketSchema>;

export const VarianceAgingRowSchema = z.object({
  bucket: VarianceAgingBucketSchema,
  count: z.number().int().nonnegative(),
  // Sum of expectedAmount across unsettled claims in this bucket.
  // Helps the CFO see "₹X aged 30+ days unpaid".
  outstandingAmount: z.number().int().nonnegative(),
});
export type VarianceAgingRow = z.infer<typeof VarianceAgingRowSchema>;

export const VarianceSummaryResponseSchema = z.object({
  // All amounts in paise. Sum across claims whose status is past
  // the eligibility gate (i.e. real billable claims).
  totalBilled: z.number().int().nonnegative(),
  totalApproved: z.number().int().nonnegative(),
  totalPaid: z.number().int().nonnegative(),
  totalBilledVariance: z.number().int(), // can be negative if approved > billed (rare)
  totalShortPay: z.number().int().nonnegative(),
  totalNetLeakage: z.number().int(),
  // Count of adjudicated claims contributing to the variance number.
  contributingClaimCount: z.number().int().nonnegative(),
  // Outstanding aging — sum(expectedAmount) per bucket where the
  // claim is unsettled. Empty buckets are omitted.
  aging: z.array(VarianceAgingRowSchema),
  // Snapshot reference time so the UI can show "as of ...".
  reportedAt: z.string().datetime(),
});
export type VarianceSummaryResponse = z.infer<typeof VarianceSummaryResponseSchema>;

export const VariancePayerRowSchema = z.object({
  payerCode: z.string(),
  claimCount: z.number().int().nonnegative(),
  totalBilled: z.number().int().nonnegative(),
  totalApproved: z.number().int().nonnegative(),
  totalPaid: z.number().int().nonnegative(),
  billedVariance: z.number().int(),
  shortPay: z.number().int().nonnegative(),
  netLeakage: z.number().int(),
  // billedVariance / totalBilled, 0–1. UI renders as percentage.
  varianceRate: z.number(),
});
export type VariancePayerRow = z.infer<typeof VariancePayerRowSchema>;

export const VarianceByPayerResponseSchema = z.object({
  rows: z.array(VariancePayerRowSchema),
});
export type VarianceByPayerResponse = z.infer<typeof VarianceByPayerResponseSchema>;

// Drill-down list. Every entry is a single claim; the row exposes
// only the columns the dashboard table needs.
export const VarianceClaimRowSchema = z.object({
  claimId: z.string().uuid(),
  caseId: z.string().uuid(),
  patientName: z.string(),
  payerCode: z.string().nullable(),
  status: z.string(),
  claimRefNum: z.string().nullable(),
  claimAmount: z.number().int().nullable(),
  approvedAmount: z.number().int().nullable(),
  paidAmount: z.number().int().nullable(),
  billedVariance: z.number().int().nullable(),
  shortPay: z.number().int().nullable(),
  agingDays: z.number().int().nullable(),
  submittedAt: z.string().datetime().nullable(),
});
export type VarianceClaimRow = z.infer<typeof VarianceClaimRowSchema>;

export const VarianceClaimsResponseSchema = z.object({
  rows: z.array(VarianceClaimRowSchema),
  total: z.number().int().nonnegative(),
});
export type VarianceClaimsResponse = z.infer<typeof VarianceClaimsResponseSchema>;
