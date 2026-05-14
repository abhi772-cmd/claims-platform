import {
  type KycDocument,
  type KycDocumentStatus,
  type KycReviewDetail,
  type KycReviewQueueResponse,
  type KycReviewRequest,
} from '@claims/contracts';

import { apiRequest } from './client';

// Slice ON-3 — KYC ops review client (platform_admin only). The web
// admin shell mounts the queue + detail under /admin/kyc-review/*.
export const KycReviewApi = {
  queue: (params: {
    status?: KycDocumentStatus;
    tenantId?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<KycReviewQueueResponse> => {
    const search = new URLSearchParams();
    if (params.status) search.set('status', params.status);
    if (params.tenantId) search.set('tenantId', params.tenantId);
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    if (params.offset !== undefined) search.set('offset', String(params.offset));
    const qs = search.toString();
    return apiRequest<KycReviewQueueResponse>(
      `/admin/kyc/queue${qs ? `?${qs}` : ''}`,
    );
  },

  detail: (documentId: string): Promise<KycReviewDetail> =>
    apiRequest<KycReviewDetail>(`/admin/kyc/${encodeURIComponent(documentId)}`),

  review: (documentId: string, body: KycReviewRequest): Promise<KycDocument> =>
    apiRequest<KycDocument>(
      `/admin/kyc/${encodeURIComponent(documentId)}/review`,
      { method: 'POST', body },
    ),
};
