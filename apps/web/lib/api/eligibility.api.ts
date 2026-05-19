// Eligibility clients — two endpoints:
//
//   1. Preflight (pre-case): POST /eligibility/verify-by-identifiers
//      Called from /cases/new before the case+claim chain exists. In
//      stub mode the response carries synthesised benefits (deductible,
//      co-pay, room limit) which the new-case form auto-fills.
//
//   2. Per-claim cycle (post-case): POST /cases/:caseId/claims/:claimId/eligibility
//      PMJAY runs eligibility three times with different purposes:
//        - validation         post-registration wallet / member-active
//        - benefits           before preauth, fetches coverage limits
//        - auth-requirements  before claim submit, fetches doc checklist
//      Private rails use the legacy implicit purpose (omit the field).
//
// In real mode the gateway returns the FHIR Bundle asynchronously via
// the inbound callback; this response is the synchronous ack.

import {
  type DiscoverByMobileRequest,
  type DiscoverByMobileResponse,
  type EligibilityPurpose,
  type EligibilityRequest,
  type EligibilityResponse,
  type VerifyCoverageByIdentifiersRequest,
  type VerifyCoverageByIdentifiersResponse,
} from '@claims/contracts';

import { apiRequest } from './client';

export const EligibilityApi = {
  verifyByIdentifiers: (
    body: VerifyCoverageByIdentifiersRequest,
  ): Promise<VerifyCoverageByIdentifiersResponse> =>
    apiRequest<VerifyCoverageByIdentifiersResponse>('/eligibility/verify-by-identifiers', {
      method: 'POST',
      body,
    }),

  // Phase 3 — NHCX mobile-based discovery. Only callable for payers
  // with supportsDiscoveryByMobile=true on the master row; the API
  // rejects other payers with a friendly 422 the IdentityDiscovery
  // widget surfaces in the validation message slot.
  discoverByMobile: (body: DiscoverByMobileRequest): Promise<DiscoverByMobileResponse> =>
    apiRequest<DiscoverByMobileResponse>('/eligibility/discover-by-mobile', {
      method: 'POST',
      body,
    }),

  runForClaim: (
    caseId: string,
    claimId: string,
    body: EligibilityRequest,
  ): Promise<EligibilityResponse> =>
    apiRequest<EligibilityResponse>(`/cases/${caseId}/claims/${claimId}/eligibility`, {
      method: 'POST',
      body,
    }),

  // Convenience wrappers for the three PMJAY purposes — keep call
  // sites in the panels readable. Each just sets `purpose` on the
  // common shape.
  runValidation: (
    caseId: string,
    claimId: string,
    body: Omit<EligibilityRequest, 'purpose'> = {},
  ): Promise<EligibilityResponse> =>
    EligibilityApi.runForClaim(caseId, claimId, { ...body, purpose: 'validation' satisfies EligibilityPurpose }),

  runBenefits: (
    caseId: string,
    claimId: string,
    body: Omit<EligibilityRequest, 'purpose'> = {},
  ): Promise<EligibilityResponse> =>
    EligibilityApi.runForClaim(caseId, claimId, { ...body, purpose: 'benefits' satisfies EligibilityPurpose }),

  runAuthRequirements: (
    caseId: string,
    claimId: string,
    body: Omit<EligibilityRequest, 'purpose'> = {},
  ): Promise<EligibilityResponse> =>
    EligibilityApi.runForClaim(caseId, claimId, { ...body, purpose: 'auth-requirements' satisfies EligibilityPurpose }),
} as const;
