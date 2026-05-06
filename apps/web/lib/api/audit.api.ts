import {
  type AuditLogFilter,
  type AuditLogListResponse,
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

export const AuditApi = {
  list: (
    params: AuditLogFilter & { limit?: number; offset?: number } = {},
  ): Promise<AuditLogListResponse> =>
    apiRequest<AuditLogListResponse>(`/audit${qs(params)}`),

  // The export endpoint streams CSV — return the URL the browser
  // should hit so it can use a normal anchor download with cookies
  // attached. Doing the fetch ourselves would force materialising
  // the body in memory before downloading, defeating the streaming.
  exportUrl: (params: AuditLogFilter = {}): string => {
    const apiBase =
      typeof process !== 'undefined' && process.env['NEXT_PUBLIC_API_URL']
        ? process.env['NEXT_PUBLIC_API_URL']
        : 'http://localhost:3001';
    return `${apiBase}/audit/export.csv${qs(params)}`;
  },
};
