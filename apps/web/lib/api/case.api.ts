import {
  type CaseDetail,
  type ClaimEventListResponse,
  type CreateCaseRequest,
  type ListCasesResponse,
  type ManualTransitionRequest,
  type UpdateCaseRequest,
} from '@claims/contracts';

import { apiRequest } from './client';

export const CaseApi = {
  list: (params?: {
    limit?: number;
    offset?: number;
    status?: 'open' | 'closed' | 'abandoned';
  }): Promise<ListCasesResponse> => {
    const q = new URLSearchParams();
    if (params?.limit !== undefined) q.set('limit', String(params.limit));
    if (params?.offset !== undefined) q.set('offset', String(params.offset));
    if (params?.status) q.set('status', params.status);
    const query = q.toString();
    return apiRequest<ListCasesResponse>(`/cases${query ? `?${query}` : ''}`);
  },

  create: (body: CreateCaseRequest): Promise<CaseDetail> =>
    apiRequest<CaseDetail>('/cases', { method: 'POST', body }),

  getById: (id: string): Promise<CaseDetail> =>
    apiRequest<CaseDetail>(`/cases/${encodeURIComponent(id)}`),

  update: (id: string, body: UpdateCaseRequest): Promise<CaseDetail> =>
    apiRequest<CaseDetail>(`/cases/${encodeURIComponent(id)}`, { method: 'PATCH', body }),

  listClaimEvents: (caseId: string, claimId: string): Promise<ClaimEventListResponse> =>
    apiRequest<ClaimEventListResponse>(
      `/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(claimId)}/events`,
    ),

  manualTransition: (
    caseId: string,
    claimId: string,
    body: ManualTransitionRequest,
  ): Promise<{ status: string }> =>
    apiRequest<{ status: string }>(
      `/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(claimId)}/transitions`,
      { method: 'POST', body },
    ),
};
