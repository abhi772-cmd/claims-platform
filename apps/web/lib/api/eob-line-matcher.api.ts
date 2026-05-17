import {
  type ConfirmEobLineMatchRequest,
  type EobLineMatchesResponse,
} from '@claims/contracts';

import { apiRequest } from './client';

// EOB-line matcher client.
//   list    — GET suggestion bundle for one claim.
//   confirm — POST a reviewer-confirmed mapping (Phase 2).
//   reset   — DELETE one confirmation; matcher re-auto-suggests.
export const EobLineMatcherApi = {
  list: (caseId: string, claimId: string): Promise<EobLineMatchesResponse> =>
    apiRequest<EobLineMatchesResponse>(
      `/cases/${caseId}/claims/${claimId}/eob-line-matches`,
    ),

  confirm: (
    caseId: string,
    claimId: string,
    body: ConfirmEobLineMatchRequest,
  ): Promise<EobLineMatchesResponse> =>
    apiRequest<EobLineMatchesResponse>(
      `/cases/${caseId}/claims/${claimId}/eob-line-matches/confirm`,
      { method: 'POST', body },
    ),

  reset: (
    caseId: string,
    claimId: string,
    deductionIndex: number,
  ): Promise<EobLineMatchesResponse> =>
    apiRequest<EobLineMatchesResponse>(
      `/cases/${caseId}/claims/${claimId}/eob-line-matches/${deductionIndex}`,
      { method: 'DELETE' },
    ),
};
