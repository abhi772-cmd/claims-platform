// Shared adapter contract for NHCX. Both NhcxStubAdapter and the real
// NhcxJweAdapter conform to this — the eligibility / preauth / discharge
// / claim-submit services depend on the interface (NHCX_ADAPTER token)
// and are oblivious to which one is bound.
//
// Inputs were enriched in Slice T to carry the patient / coverage /
// clinical fields that the FHIR R4 bundles need. The stub ignores
// the new fields; the JWE adapter turns them into proper
// CoverageEligibilityRequest / Claim / Communication bundles.

export const NHCX_ADAPTER = Symbol('NHCX_ADAPTER');

export interface AdapterPatientFields {
  fullName: string;
  hospitalMrn: string;
  dateOfBirth?: string | null;
  gender?: 'male' | 'female' | 'other' | 'prefer_not_to_say' | null;
  abhaId?: string;
  policyNumber?: string;
}

export interface AdapterCoverageFields {
  payerCode: string;
  payerDisplayName?: string;
  memberId: string;
}

// Slice BK — PMJAY runs eligibility three times with different purposes
// (one per FHIR CoverageEligibilityRequest.purpose value). Private rails
// kept the legacy combined ['benefits','validation'] array; that lives
// in the FHIR builder as the default when purpose is omitted.
export type AdapterEligibilityPurpose = 'validation' | 'benefits' | 'auth-requirements';

export interface AdapterEligibilityRequest {
  tenantId: string;
  claimId: string;
  hospitalMrn: string;
  patientName: string;
  policyNumber?: string;
  payerCode?: string;
  // Slice T: enriched payload for FHIR bundle building. Optional so
  // existing callers + the stub keep working unchanged.
  patient?: AdapterPatientFields;
  coverage?: AdapterCoverageFields;
  serviceDate?: string;
  // Slice BK: when set, the FHIR bundle uses a single-element purpose
  // array ([purpose]); when unset, the legacy combined array is used.
  purpose?: AdapterEligibilityPurpose;
}

export interface AdapterEligibilityResponse {
  verified: boolean;
  planName?: string;
  sumInsured?: number;
  failureReason?: string;
  correlationId: string;
  rawResponse: Record<string, unknown>;
  latencyMs: number;
}

export interface AdapterPreauthSubmitInput {
  tenantId: string;
  claimId: string;
  requestedAmount: number | null;
  // Slice T enrichments — optional for back-compat.
  patient?: AdapterPatientFields;
  coverage?: AdapterCoverageFields;
  diagnosisIcdCode?: string;
  diagnosisDescription?: string;
  plannedProcedure?: string;
  procedureCode?: string;
  estimatedLengthOfStayDays?: number | null;
  clinicalJustification?: string;
}

export interface AdapterPreauthSubmitResult {
  acknowledged: boolean;
  payerRefNum: string;
  correlationId: string;
  rawRequest: Record<string, unknown>;
  rawResponse: Record<string, unknown>;
}

export interface AdapterPreauthQueryRespondInput {
  tenantId: string;
  claimId: string;
  queryId: string;
  responseText: string;
  // Slice T: actor codes for the FHIR Communication bundle. Optional
  // because the stub doesn't need them.
  patient?: AdapterPatientFields;
  coverage?: AdapterCoverageFields;
  inReplyToRefNum?: string;
}

export interface AdapterEnvelopedResult {
  correlationId: string;
  rawRequest: Record<string, unknown>;
  rawResponse: Record<string, unknown>;
}

export interface AdapterDischargeSubmitInput {
  tenantId: string;
  claimId: string;
  documentIds: string[];
  patient?: AdapterPatientFields;
  coverage?: AdapterCoverageFields;
}

export interface AdapterClaimSubmitInput {
  tenantId: string;
  claimId: string;
  finalAmount: number;
  documentIds?: string[];
  patient?: AdapterPatientFields;
  coverage?: AdapterCoverageFields;
  diagnosisIcdCode?: string;
  diagnosisDescription?: string;
  plannedProcedure?: string;
  procedureCode?: string;
  clinicalJustification?: string;
}

export interface AdapterClaimSubmitResult {
  acknowledged: boolean;
  claimRefNum: string;
  correlationId: string;
  rawRequest: Record<string, unknown>;
  rawResponse: Record<string, unknown>;
}

// Slice BH — outbound `task/submit` with PMJAY's `code: 'cancel',
// inputType: 'ClaimNumber'` shape. Cancels a previously-submitted
// preauth on the gateway. The payer either acks (gateway pushes
// task/on_submit asynchronously) or the operator can drive the
// transition manually if the payer is offline.
//
// We type a single `cancelPreauth` method rather than a generic
// `submitTask` so callers stay honest about the operation —
// reprocess (Slice BI) will get its own typed input/output.
export interface AdapterPreauthCancelInput {
  tenantId: string;
  claimId: string;
  // Echoed onto the gateway under PMJAY's `inputType: 'ClaimNumber'`
  // payload so the payer can correlate to their own claim record.
  // Sourced from claim.preauthRefNum (or claim.payerRefNum) on the
  // service side; nullable here to keep the adapter dumb when neither
  // is set (the service guards against this — adapter just bubbles
  // up an empty value if it happens).
  preauthRefNum: string | null;
  // Free-form operator note — surfaced on the FHIR Task bundle as a
  // `note[].text` so the payer's audit trail captures *why* the
  // hospital cancelled.
  reason?: string;
  patient?: AdapterPatientFields;
  coverage?: AdapterCoverageFields;
}

export interface AdapterPreauthCancelResult {
  acknowledged: boolean;
  correlationId: string;
  rawRequest: Record<string, unknown>;
  rawResponse: Record<string, unknown>;
}

// Slice BI — outbound `task/submit` with PMJAY's `code: 'reprocess'`
// shape. Used to request re-evaluation of a previously-decisioned
// claim. Two reason codes per the PMJAY supporting docs:
//   - 'claimrejected'  — claim was rejected; hospital wants the
//                        payer to look again (often after providing
//                        clarifying documentation out-of-band).
//   - 'partialpayment' — claim was settled short of expected; the
//                        hospital is contesting the deductions.
//
// The reprocess request is a hospital-asserted re-open of the case
// on the payer side. The payer eventually responds with a fresh
// claim/on_submit decision (handled by the existing inbound
// dispatcher).
export type AdapterClaimReprocessReason = 'claimrejected' | 'partialpayment';

export interface AdapterClaimReprocessInput {
  tenantId: string;
  claimId: string;
  // Echoed onto the gateway under PMJAY's ClaimNumber input — the
  // gateway-issued claim reference from the original claim/submit.
  // Sourced from claim.claimRefNum on the service side.
  claimRefNum: string | null;
  reasonCode: AdapterClaimReprocessReason;
  // Free-form operator note explaining what changed since the
  // original decision (e.g. "additional discharge summary attached
  // out-of-band, please reconsider").
  reason?: string;
  patient?: AdapterPatientFields;
  coverage?: AdapterCoverageFields;
}

export interface AdapterClaimReprocessResult {
  acknowledged: boolean;
  correlationId: string;
  rawRequest: Record<string, unknown>;
  rawResponse: Record<string, unknown>;
}

// Slice BJ — PMJAY beneficiary policies lookup. Pre-eligibility step
// where the operator enters an ABHA number (without hyphens) or a
// mobile number, and the API returns the list of PMJAY policies the
// beneficiary is enrolled in. The operator picks one to attach to
// the case before running eligibility. Plain-REST endpoint on the
// gateway side (NOT JWE-wrapped) — the NHCX PMJAY Integration
// Handbook §5.6 documents the internal wrapper but leaves the
// upstream URL for sandbox/prod gateway as TBD; real-mode is a
// follow-up slice once the URL is published.
//
// Identifier types per the scenario doc are ABHA + mobile only.
// Aadhaar is intentionally NOT supported here; PMJAY's policies
// API requires the beneficiary to have linked their ABHA / mobile
// at registration.
export type AdapterPmjayLookupIdentifierType = 'abha' | 'mobile';

export interface AdapterPmjayPolicyLookupInput {
  tenantId: string;
  identifierType: AdapterPmjayLookupIdentifierType;
  // Format-checked at the controller. ABHA: 14 digits, no hyphens.
  // Mobile: 10 digits.
  identifier: string;
}

// Per-policy fields the NHCX PMJAY Integration Handbook §5.6
// commits to as documented downstream consumers' shape. Optional
// fields are left out rather than null'd because the upstream
// gateway omits them in the same way.
export interface AdapterPmjayPolicy {
  payerId: string;
  memberId: string;
  productId: string;
  productName: string;
  policyNumber: string;
}

export interface AdapterPmjayPolicyLookupResult {
  policies: AdapterPmjayPolicy[];
  // Echoed back for cross-referencing; the operator-facing UI
  // surfaces this so the lookup is auditable end-to-end.
  identifierType: AdapterPmjayLookupIdentifierType;
  identifier: string;
}

// Stage 5 — hospital-initiated communication/request outbound.
// Distinct from `respondPreauthQuery` (which is a state-transitioning
// gesture using the `preauth/query/respond` operation): this method
// sends a free-form Communication bundle under the canonical
// `communication/request` operation. Used for T2-6 variance questions,
// T2-10 release-and-settle-later notes, T3-3 partial-approval queries.
export interface AdapterCommunicationSendInput {
  tenantId: string;
  claimId: string;
  text: string;
  // Optional thread pointer. When set, the FHIR Communication bundle
  // carries an inResponseTo[] reference identifying the earlier
  // message by the payer-side reference number (preauth ref num or
  // claim ref num — whichever was captured on the claim row).
  inReplyToRefNum?: string;
  patient?: AdapterPatientFields;
  coverage?: AdapterCoverageFields;
}

export interface AdapterCommunicationSendResult {
  correlationId: string;
  rawRequest: Record<string, unknown>;
  rawResponse: Record<string, unknown>;
}

// T2-8 — preauth enhancement. At the wire level NHCX treats this as a
// follow-up `preauth/submit` referencing the original preauthRefNum
// with a revised total amount; the payer recognises the
// enhancement by the back-reference. We expose it as a distinct
// adapter method so the EnhancementService stays typed honestly
// and so future rail-specific quirks (PMJAY uses different
// `task/submit` shapes for some enhancement classes) live in
// one place.
export interface AdapterEnhancementSubmitInput {
  tenantId: string;
  claimId: string;
  // The gateway-issued reference number from the original preauth.
  // Used by the payer to thread the enhancement onto the prior
  // approval. Service layer guards against null before calling.
  priorPreauthRefNum: string;
  // The new TOTAL amount the hospital is requesting (not the
  // delta) — same convention as the original submitPreauth
  // `requestedAmount`.
  revisedAmount: number;
  // Operator-supplied free-form justification. Surfaced on the
  // FHIR Communication side note attached to the bundle.
  reason: string;
  patient?: AdapterPatientFields;
  coverage?: AdapterCoverageFields;
}

export interface AdapterEnhancementSubmitResult {
  acknowledged: boolean;
  // Echo of the prior preauth ref num so callers can match the
  // ack to the originating claim. Some payers issue a fresh
  // enhancement ref num here; we surface that separately if /
  // when it appears on the wire.
  payerRefNum: string;
  correlationId: string;
  rawRequest: Record<string, unknown>;
  rawResponse: Record<string, unknown>;
}

export interface NhcxAdapter {
  verifyEligibility(input: AdapterEligibilityRequest): Promise<AdapterEligibilityResponse>;
  submitPreauth(input: AdapterPreauthSubmitInput): Promise<AdapterPreauthSubmitResult>;
  respondPreauthQuery(
    input: AdapterPreauthQueryRespondInput,
  ): Promise<AdapterEnvelopedResult>;
  submitDischarge(input: AdapterDischargeSubmitInput): Promise<AdapterEnvelopedResult>;
  submitClaim(input: AdapterClaimSubmitInput): Promise<AdapterClaimSubmitResult>;
  cancelPreauth(input: AdapterPreauthCancelInput): Promise<AdapterPreauthCancelResult>;
  reprocessClaim(input: AdapterClaimReprocessInput): Promise<AdapterClaimReprocessResult>;
  lookupPmjayPolicies(
    input: AdapterPmjayPolicyLookupInput,
  ): Promise<AdapterPmjayPolicyLookupResult>;
  sendCommunication(
    input: AdapterCommunicationSendInput,
  ): Promise<AdapterCommunicationSendResult>;
  submitEnhancement(
    input: AdapterEnhancementSubmitInput,
  ): Promise<AdapterEnhancementSubmitResult>;
}
