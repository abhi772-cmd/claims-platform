import {
  type VarianceAgingBucket,
  type VarianceByPayerResponse,
  type VarianceClaimsResponse,
  type VarianceSummaryResponse,
} from '@claims/contracts';

import { apiRequest } from './client';

export const VarianceApi = {
  summary: (): Promise<VarianceSummaryResponse> =>
    apiRequest<VarianceSummaryResponse>('/analytics/variance/summary'),

  byPayer: (params?: { limit?: number }): Promise<VarianceByPayerResponse> => {
    const q = new URLSearchParams();
    if (params?.limit !== undefined) q.set('limit', String(params.limit));
    const qs = q.toString();
    return apiRequest<VarianceByPayerResponse>(
      `/analytics/variance/by-payer${qs ? `?${qs}` : ''}`,
    );
  },

  claims: (params?: {
    bucket?: VarianceAgingBucket;
    payerCode?: string;
    limit?: number;
  }): Promise<VarianceClaimsResponse> => {
    const q = new URLSearchParams();
    if (params?.bucket) q.set('bucket', params.bucket);
    if (params?.payerCode) q.set('payerCode', params.payerCode);
    if (params?.limit !== undefined) q.set('limit', String(params.limit));
    const qs = q.toString();
    return apiRequest<VarianceClaimsResponse>(
      `/analytics/variance/claims${qs ? `?${qs}` : ''}`,
    );
  },
};
