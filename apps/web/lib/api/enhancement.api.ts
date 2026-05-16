import {
  type EnhancementResponse,
  type EnhancementStartRequest,
  type EnhancementSubmitRequest,
} from '@claims/contracts';

import { apiRequest } from './client';

// T2-8 — preauth enhancement.
//   start  — flips claim into ENHANCEMENT_DRAFTING
//   submit — flips ENHANCEMENT_DRAFTING → ENHANCEMENT_QUEUED + adapter call
export const EnhancementApi = {
  start: (
    caseId: string,
    claimId: string,
    body: EnhancementStartRequest = {},
  ): Promise<EnhancementResponse> =>
    apiRequest<EnhancementResponse>(
      `/cases/${caseId}/claims/${claimId}/enhancement/start`,
      { method: 'POST', body },
    ),

  submit: (
    caseId: string,
    claimId: string,
    body: EnhancementSubmitRequest,
  ): Promise<EnhancementResponse> =>
    apiRequest<EnhancementResponse>(
      `/cases/${caseId}/claims/${claimId}/enhancement/submit`,
      { method: 'POST', body },
    ),
};
