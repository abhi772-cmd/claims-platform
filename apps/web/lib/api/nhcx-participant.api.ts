import {
  type NhcxParticipantConfig,
  type NhcxParticipantListResponse,
  type NhcxParticipantStatusResponse,
  type RegisterNhcxParticipantRequest,
} from '@claims/contracts';

import { apiRequest } from './client';

// Slice ON-4 — admin client for the cross-tenant NHCX participant
// registration flow. All routes gated server-side by
// nhcx.participant.manage.
export const NhcxParticipantApi = {
  list: (): Promise<NhcxParticipantListResponse> =>
    apiRequest<NhcxParticipantListResponse>('/admin/nhcx-participants'),

  status: (tenantId: string): Promise<NhcxParticipantStatusResponse> =>
    apiRequest<NhcxParticipantStatusResponse>(
      `/admin/tenants/${encodeURIComponent(tenantId)}/nhcx/participant-status`,
    ),

  register: (
    tenantId: string,
    body: RegisterNhcxParticipantRequest,
  ): Promise<NhcxParticipantConfig> =>
    apiRequest<NhcxParticipantConfig>(
      `/admin/tenants/${encodeURIComponent(tenantId)}/nhcx/register-participant`,
      { method: 'POST', body },
    ),
};
