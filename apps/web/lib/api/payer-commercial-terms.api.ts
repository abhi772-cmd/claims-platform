import {
  type PayerCommercialTerms,
  type PayerCommercialTermsListResponse,
  type PayerOnboardingStatusResponse,
  type UpsertPayerCommercialTermsRequest,
} from '@claims/contracts';

import { apiRequest } from './client';

export const PayerCommercialTermsApi = {
  list: (): Promise<PayerCommercialTermsListResponse> =>
    apiRequest<PayerCommercialTermsListResponse>('/admin/payer-commercial-terms'),

  // Aggregate per-payer completeness across the room-rate catalog AND
  // the terms table. Drives the onboarding step's status table.
  status: (): Promise<PayerOnboardingStatusResponse> =>
    apiRequest<PayerOnboardingStatusResponse>('/admin/payer-commercial-terms/status'),

  get: (payerCode: string): Promise<PayerCommercialTerms> =>
    apiRequest<PayerCommercialTerms>(
      `/admin/payer-commercial-terms/${encodeURIComponent(payerCode)}`,
    ),

  // Upsert by (tenantId, payerCode). PUT because the operation is
  // idempotent and the natural key is in the body.
  upsert: (body: UpsertPayerCommercialTermsRequest): Promise<PayerCommercialTerms> =>
    apiRequest<PayerCommercialTerms>('/admin/payer-commercial-terms', {
      method: 'PUT',
      body,
    }),

  deactivate: (payerCode: string): Promise<void> =>
    apiRequest<void>(
      `/admin/payer-commercial-terms/${encodeURIComponent(payerCode)}`,
      { method: 'DELETE' },
    ),
};
