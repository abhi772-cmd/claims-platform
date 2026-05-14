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

// Optional fields every outbound input may carry to participate in
// the NHCX correlation chain + use-case taxonomy. Per
// `docs/07-nhcx-and-pmjay.md` lines 98–117, every chained operation
// (insurance → coverage → preauth → enhancement → discharge → claim
// → payment) reuses the *previous* call's correlation id as its
// own `x-hcx-correlation-id`. The first call in a chain leaves
// `parentCorrelationId` unset; later calls thread it through so
// NHA-side reporting groups the whole lifecycle.
//
// `useCase` is the `x-hcx-use-case` header value the gateway uses to
// distinguish a fresh submission from an enhancement, resubmission,
// reprocess, or cancellation.
export interface NhcxChainFields {
  parentCorrelationId?: string;
  useCase?: 'New' | 'Enhancement' | 'Resubmission' | 'Reprocess' | 'Cancel';
}

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

export interface AdapterEligibilityRequest extends NhcxChainFields {
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

export interface AdapterPreauthSubmitInput extends NhcxChainFields {
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

export interface AdapterPreauthQueryRespondInput extends NhcxChainFields {
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

export interface AdapterDischargeSubmitInput extends NhcxChainFields {
  tenantId: string;
  claimId: string;
  documentIds: string[];
  patient?: AdapterPatientFields;
  coverage?: AdapterCoverageFields;
}

export interface AdapterClaimSubmitInput extends NhcxChainFields {
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
export interface AdapterPreauthCancelInput extends NhcxChainFields {
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

export interface AdapterClaimReprocessInput extends NhcxChainFields {
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

// `insuranceplan/request` — chain root operation. The hospital sends
// a policy number + provider id and the payer responds asynchronously
// via `insuranceplan/on_request` with an InsurancePlan resource. The
// correlation id returned here is what we stamp into Claim.
// insuranceCorrelationId so every later HCX-chained call inherits it.
export interface AdapterInsurancePlanRequestInput extends NhcxChainFields {
  tenantId: string;
  // Optional — set when the lookup is tied to a specific in-flight
  // claim row that should have insuranceCorrelationId stamped. When
  // null the lookup is freestanding (e.g. pre-admission policy
  // verification before any claim row has been opened).
  claimId?: string;
  payerCode: string;
  policyNumber: string;
  providerId: string;
  patient?: AdapterPatientFields;
  // Optional display strings to enrich the FHIR Organization resources
  // on the outbound bundle. The lookup works without them; humans
  // reading the ledger appreciate them.
  payerDisplayName?: string;
  hospitalDisplayName?: string;
}

export interface AdapterInsurancePlanRequestResult {
  // True on synchronous gateway ack. The actual plan details arrive
  // asynchronously on the `insuranceplan/on_request` callback.
  acknowledged: boolean;
  correlationId: string;
  rawRequest: Record<string, unknown>;
  rawResponse: Record<string, unknown>;
}

export interface NhcxAdapter {
  verifyEligibility(input: AdapterEligibilityRequest): Promise<AdapterEligibilityResponse>;
  requestInsurancePlan(
    input: AdapterInsurancePlanRequestInput,
  ): Promise<AdapterInsurancePlanRequestResult>;
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
}
