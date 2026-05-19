// Phase 4 — smart identity-discovery orchestrator. The /identity/discover
// endpoint accepts any combination of {mobile, abhaId, aadhaar,
// policyNumber} and runs them across the rails the tenant is enabled
// for in best-to-worst order, returning the union of matches.
//
// Best-to-worst order is fixed (most specific identifier first):
//   1. policyNumber → NHCX verify-by-identifiers
//   2. abhaId       → PMJAY policies/lookup, then NHCX verify-by-identifiers
//   3. aadhaar      → PMJAY policies/lookup (derived ABHA),
//                     NHCX verify-by-identifiers
//   4. mobile       → PMJAY policies/lookup, NHCX discover-by-mobile
//                     for each NHCX payer with supportsDiscoveryByMobile=true
//
// Stops dispatching as soon as ANY identifier surfaces at least one
// policy across either rail. The endpoint is idempotent + read-only;
// no DB writes happen until the operator picks one of the returned
// candidates and creates the case.

import { z } from 'zod';

export const IdentityDiscoverRequestSchema = z
  .object({
    // At least one identifier must be present. Empty inputs are
    // rejected at the schema layer so the operator gets immediate
    // feedback rather than a remote round-trip.
    mobile: z.string().regex(/^\d{10}$/).optional(),
    abhaId: z.string().regex(/^\d{14}$/).optional(),
    aadhaar: z.string().regex(/^\d{12}$/).optional(),
    policyNumber: z.string().min(4).max(64).optional(),
    // Optional context — improves the verify-by-identifiers call when
    // included. The orchestrator falls back to "Identity Discovery"
    // placeholders when omitted.
    patientName: z.string().min(1).max(200).optional(),
    hospitalMrn: z.string().min(1).max(64).optional(),
  })
  .refine(
    (val) =>
      Boolean(val.mobile || val.abhaId || val.aadhaar || val.policyNumber),
    {
      message:
        'Supply at least one of: mobile, abhaId, aadhaar, policyNumber.',
      path: ['mobile'],
    },
  );
export type IdentityDiscoverRequest = z.infer<typeof IdentityDiscoverRequestSchema>;

// A single match — either a PMJAY beneficiary policy or an NHCX
// coverage hit, normalised into a common shape. `source` is the
// path that produced it so the UI can label the row.
export const IdentityDiscoverCandidateSchema = z.object({
  source: z.enum([
    'pmjay_policies_lookup',
    'nhcx_verify_by_identifiers',
    'nhcx_discover_by_mobile',
  ]),
  identifierKind: z.enum(['mobile', 'abha', 'aadhaar', 'policy']),
  identifierValue: z.string(),
  payerCode: z.string(),
  payerName: z.string().nullable(),
  policyNumber: z.string().nullable(),
  productName: z.string().nullable(),
  memberId: z.string().nullable(),
  sumInsuredRupees: z.number().nullable(),
});
export type IdentityDiscoverCandidate = z.infer<typeof IdentityDiscoverCandidateSchema>;

export const IdentityDiscoverResponseSchema = z.object({
  candidates: z.array(IdentityDiscoverCandidateSchema),
  // Per-identifier diagnostic. Lets the UI render "we tried mobile and
  // found nothing; we tried policy and found 1 match" without forcing
  // the operator to re-run searches one at a time.
  attempts: z.array(
    z.object({
      identifierKind: z.enum(['mobile', 'abha', 'aadhaar', 'policy']),
      source: z.enum([
        'pmjay_policies_lookup',
        'nhcx_verify_by_identifiers',
        'nhcx_discover_by_mobile',
      ]),
      outcome: z.enum(['matched', 'not_found', 'skipped', 'error']),
      errorMessage: z.string().nullable(),
    }),
  ),
  // When zero candidates were found, the recommended next step the
  // UI surfaces ("Create ABHA via Aadhaar OTP", "Ask patient for
  // policy number", "Contact payer helpline").
  suggestedNextStep: z
    .enum(['create_abha', 'ask_for_policy_number', 'contact_payer_helpline', 'none'])
    .nullable(),
});
export type IdentityDiscoverResponse = z.infer<typeof IdentityDiscoverResponseSchema>;
