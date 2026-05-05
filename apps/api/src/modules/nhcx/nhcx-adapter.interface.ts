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

export interface NhcxAdapter {
  verifyEligibility(input: AdapterEligibilityRequest): Promise<AdapterEligibilityResponse>;
  submitPreauth(input: AdapterPreauthSubmitInput): Promise<AdapterPreauthSubmitResult>;
  respondPreauthQuery(
    input: AdapterPreauthQueryRespondInput,
  ): Promise<AdapterEnvelopedResult>;
  submitDischarge(input: AdapterDischargeSubmitInput): Promise<AdapterEnvelopedResult>;
  submitClaim(input: AdapterClaimSubmitInput): Promise<AdapterClaimSubmitResult>;
}
