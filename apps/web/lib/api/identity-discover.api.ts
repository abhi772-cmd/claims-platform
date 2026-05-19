// Phase 4 — smart identity-discovery orchestrator client. Single
// /identity/discover call accepts any combination of identifiers and
// returns the union of matches plus per-attempt diagnostic.

import {
  type IdentityDiscoverRequest,
  type IdentityDiscoverResponse,
} from '@claims/contracts';

import { apiRequest } from './client';

export const IdentityDiscoverApi = {
  discover: (body: IdentityDiscoverRequest): Promise<IdentityDiscoverResponse> =>
    apiRequest<IdentityDiscoverResponse>('/identity/discover', {
      method: 'POST',
      body,
    }),
} as const;
