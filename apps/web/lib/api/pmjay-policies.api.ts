// PMJAY beneficiary policies lookup client. Pre-case discovery step
// the operator runs from /cases/new before they know which policy to
// attach. Backed by POST /pmjay/policies/lookup which is PMJAY-rail-
// only (the API service rejects calls from non-PMJAY tenants).
//
// Stub mode returns deterministic fixtures keyed on the identifier
// prefix: STUB-EMPTY-* → no policies, STUB-MULTI-* → two policies,
// any other identifier → one policy. See nhcx-stub.adapter.ts.

import {
  type PmjayPolicyLookupRequest,
  type PmjayPolicyLookupResponse,
} from '@claims/contracts';

import { apiRequest } from './client';

export const PmjayPoliciesApi = {
  lookup: (body: PmjayPolicyLookupRequest): Promise<PmjayPolicyLookupResponse> =>
    apiRequest<PmjayPolicyLookupResponse>('/pmjay/policies/lookup', {
      method: 'POST',
      body,
    }),
} as const;
