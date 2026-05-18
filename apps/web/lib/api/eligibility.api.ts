// Preflight eligibility client — used by /cases/new to look up the
// policy BEFORE the case is created. Backed by
// POST /eligibility/verify-by-identifiers (eligibility-preflight.controller).
//
// In stub mode the response carries synthesised benefits (deductible,
// co-pay, room-rent limit) which the new-case form auto-fills. In
// real mode benefits arrive via the async callback so this returns
// nulls and the operator proceeds with the standard intake → submit
// → wait-for-callback flow.

import {
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
} as const;
