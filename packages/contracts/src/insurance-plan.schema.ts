import { z } from 'zod';

// Read-side projection of the operator-facing insurance plan
// summary. Distinct from the FHIR `InsurancePlan` resource the
// gateway pushes — that lives in the integration_message ledger
// for ops triage. This shape is the post-extract "what does the
// operator need to see on the case-detail page" view.
//
// Composed from three sources at read time:
//   1. Latest `eligibility.verified` ClaimEvent → planName,
//      sumInsured.
//   2. Case row → policyRoomRentLimit (operator-captured at
//      intake under T2-14).
//   3. Claim row → approvedAmount (sum-to-date allocations).
//
// We don't persist a denormalised copy — the source-of-truth
// columns are already on those rows. Phase 2 will add real
// `Coverage.benefit[]` extraction once a richer FHIR parser
// lands; until then deductibles + co-pay are surfaced as
// "not extracted yet" placeholders.

export const EligibilityVerificationStatusSchema = z.enum([
  // No eligibility cycle has completed yet — the verified-event
  // doesn't exist.
  'not_run',
  // Adapter returned verified=true; the event landed and the
  // payload carries planName / sumInsured (when the gateway
  // surfaced them).
  'verified',
  // Adapter returned verified=false; the event payload carries
  // the failure reason but no plan details.
  'failed',
]);
export type EligibilityVerificationStatus = z.infer<
  typeof EligibilityVerificationStatusSchema
>;

export const InsurancePlanResponseSchema = z.object({
  status: EligibilityVerificationStatusSchema,
  // Plan name as the gateway returned it (e.g. "Star Health
  // Gold 2026"). Null when the eligibility hasn't run or the
  // gateway didn't surface a name.
  planName: z.string().nullable(),
  // Aggregate cap from the gateway. Stored as the gateway
  // returned it — typically RUPEES, not paise. The display
  // layer formats with Indian numbering. Null when not surfaced.
  sumInsured: z.number().int().nonnegative().nullable(),
  // Operator-captured at intake (T2-14). Paise. Null when the
  // operator skipped the field (emergency intake / self-pay /
  // data not available).
  policyRoomRentLimitPaise: z.number().int().nonnegative().nullable(),
  // Sum of approved allocations on the claim to date. Paise.
  // Includes preauth, enhancement, claim approvals. Null when
  // the claim hasn't reached any approval state yet.
  approvedToDatePaise: z.number().int().nonnegative().nullable(),
  // ISO timestamp of the most recent eligibility verification.
  // Null when status === 'not_run'.
  verifiedAt: z.string().datetime().nullable(),
  // Failure reason when status === 'failed'. Surfaced as a
  // banner under the card so the operator knows why the
  // plan details are missing.
  failureReason: z.string().nullable(),
});
export type InsurancePlanResponse = z.infer<typeof InsurancePlanResponseSchema>;
