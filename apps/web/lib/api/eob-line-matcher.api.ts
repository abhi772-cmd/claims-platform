import { type EobLineMatchesResponse } from '@claims/contracts';

import { apiRequest } from './client';

// EOB-line matcher (Phase 1) — single read endpoint surfacing
// the matcher's suggestions for one claim. No mutate yet; Phase 2
// will add confirm / reject endpoints alongside.
export const EobLineMatcherApi = {
  list: (caseId: string, claimId: string): Promise<EobLineMatchesResponse> =>
    apiRequest<EobLineMatchesResponse>(
      `/cases/${caseId}/claims/${claimId}/eob-line-matches`,
    ),
};
