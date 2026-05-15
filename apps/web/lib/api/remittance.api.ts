import {
  type LumpSumAllocateRequest,
  type LumpSumAllocateResponse,
  type RemittanceBatchRequest,
  type RemittanceBatchResponse,
  type RemittanceCandidatesResponse,
} from '@claims/contracts';

import { apiRequest } from './client';

export const RemittanceApi = {
  processBatch: (body: RemittanceBatchRequest): Promise<RemittanceBatchResponse> =>
    apiRequest<RemittanceBatchResponse>('/settlement/remittance', {
      method: 'POST',
      body,
    }),

  // T3-2 — lump-sum allocation suggest + apply.
  candidates: (params?: {
    payerCode?: string;
    limit?: number;
  }): Promise<RemittanceCandidatesResponse> => {
    const q = new URLSearchParams();
    if (params?.payerCode) q.set('payerCode', params.payerCode);
    if (params?.limit !== undefined) q.set('limit', String(params.limit));
    const qs = q.toString();
    return apiRequest<RemittanceCandidatesResponse>(
      `/settlement/remittance/candidates${qs ? `?${qs}` : ''}`,
    );
  },

  allocateLumpSum: (body: LumpSumAllocateRequest): Promise<LumpSumAllocateResponse> =>
    apiRequest<LumpSumAllocateResponse>('/settlement/remittance/lump-sum', {
      method: 'POST',
      body,
    }),
};
