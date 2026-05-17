import { z } from 'zod';

// Operational dashboard — read-side aggregation behind the
// dashboard landing page's "what does my team need to work on
// today" tiles. Distinct from the compliance dashboard which
// surfaces DPDP / IRDAI / RBI signals (governance audience).
//
// All counts are tenant-scoped via RLS. No new tables; the
// service derives counts from `claim.status`, IRDAI SLA state
// (computed at read time), and `case` / `appeal` rows.

export const OperationalOpenClaimsSchema = z.object({
  // Sum of the four buckets below. Surfaced separately so the
  // hero tile doesn't have to re-sum.
  total: z.number().int().nonnegative(),
  // ELIGIBILITY_*, PREAUTH_DRAFTING, CLAIM_DRAFTING, DISCHARGE_PENDING
  // — claims the operator needs to keep moving.
  drafting: z.number().int().nonnegative(),
  // PREAUTH_QUEUED / SUBMITTED / QUERY_*, ENHANCEMENT_QUEUED /
  // SUBMITTED, CLAIM_QUEUED / SUBMITTED / QUERY_*, DISCHARGE_SUBMITTED
  // — claims waiting on the payer; operator can't progress them.
  awaitingPayer: z.number().int().nonnegative(),
  // PREAUTH_APPROVED / PARTIALLY_APPROVED, ENHANCEMENT_APPROVED,
  // CLAIM_APPROVED / PARTIALLY_APPROVED — adjudicated, ready for
  // the next action (discharge / payment).
  approved: z.number().int().nonnegative(),
  // PAYMENT_PENDING / RECEIVED / SHORT_PAID — past adjudication,
  // waiting on or reconciling bank receipt.
  paymentPending: z.number().int().nonnegative(),
});
export type OperationalOpenClaims = z.infer<typeof OperationalOpenClaimsSchema>;

export const OperationalSlaAtRiskSchema = z.object({
  // SLA past its IRDAI deadline but the payer hasn't yet decided.
  // Each one is a regulatory risk; surfaced loudly.
  breached: z.number().int().nonnegative(),
  // ≥50% of the SLA window elapsed, still pending. Operator should
  // chase the payer.
  expiringSoon: z.number().int().nonnegative(),
});
export type OperationalSlaAtRisk = z.infer<typeof OperationalSlaAtRiskSchema>;

export const OperationalDashboardResponseSchema = z.object({
  openClaims: OperationalOpenClaimsSchema,
  slaAtRisk: OperationalSlaAtRiskSchema,
  // Cases where admissionDate + estimatedStayDays is today AND
  // the claim hasn't passed DISCHARGE_PENDING. Operator should
  // prepare the discharge bundle. Zero when no admission rows
  // have estimatedStayDays captured.
  dischargesDueToday: z.number().int().nonnegative(),
  // Active appeals — APPEAL_INITIATED + APPEAL_SUBMITTED. Drives
  // the appeals queue tile.
  pendingAppeals: z.number().int().nonnegative(),
  generatedAt: z.string().datetime(),
});
export type OperationalDashboardResponse = z.infer<
  typeof OperationalDashboardResponseSchema
>;
