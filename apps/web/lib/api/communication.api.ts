import {
  type ListCommunicationsResponse,
  type SendCommunicationRequest,
  type SendCommunicationResponse,
} from '@claims/contracts';

import { apiRequest } from './client';

// Stage 5 — hospital-initiated communication/request.
// Mirrors the case.api.ts shape; the panel reads listForCase on
// mount + after a successful send.
export const CommunicationApi = {
  send: (
    caseId: string,
    claimId: string,
    body: SendCommunicationRequest,
  ): Promise<SendCommunicationResponse> =>
    apiRequest<SendCommunicationResponse>(
      `/cases/${caseId}/claims/${claimId}/communications`,
      { method: 'POST', body },
    ),

  listForCase: (caseId: string): Promise<ListCommunicationsResponse> =>
    apiRequest<ListCommunicationsResponse>(`/cases/${caseId}/communications`),
};
