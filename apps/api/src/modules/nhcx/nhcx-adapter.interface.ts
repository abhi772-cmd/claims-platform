// Shared adapter contract for NHCX. Both NhcxStubAdapter and the real
// NhcxJweAdapter conform to this — the eligibility / preauth / discharge
// / claim-submit services depend on the interface (NHCX_ADAPTER token)
// and are oblivious to which one is bound.
//
// The shapes mirror what the existing stub returned in Slice K, so the
// upstream code didn't have to change when the real adapter landed.

export const NHCX_ADAPTER = Symbol('NHCX_ADAPTER');

export interface AdapterEligibilityRequest {
  tenantId: string;
  claimId: string;
  hospitalMrn: string;
  patientName: string;
  policyNumber?: string;
  payerCode?: string;
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
}

export interface AdapterClaimSubmitInput {
  tenantId: string;
  claimId: string;
  finalAmount: number;
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
