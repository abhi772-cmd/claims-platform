import {
  type ConsentListFilter,
  type ConsentListResponse,
  type ConsentRecordRow,
  type GrantConsent,
  type WithdrawConsent,
} from '@claims/contracts';

import { apiRequest } from './client';

const qs = (params: Record<string, string | number | boolean | undefined>): string => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
};

export const ConsentApi = {
  list: (params: ConsentListFilter = {}): Promise<ConsentListResponse> =>
    apiRequest<ConsentListResponse>(`/consents${qs(params)}`),

  findById: (id: string): Promise<ConsentRecordRow> =>
    apiRequest<ConsentRecordRow>(`/consents/${id}`),

  grant: (body: GrantConsent): Promise<ConsentRecordRow> =>
    apiRequest<ConsentRecordRow>('/consents', { method: 'POST', body }),

  withdraw: (id: string, body: WithdrawConsent): Promise<ConsentRecordRow> =>
    apiRequest<ConsentRecordRow>(`/consents/${id}/withdraw`, { method: 'POST', body }),
};
