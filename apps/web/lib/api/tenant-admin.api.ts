import {
  type CreateTenantRequest,
  type CreateTenantResponse,
  type ResendPrimaryInviteResponse,
  type TenantAdminDetailResponse,
  type TenantAdminListResponse,
} from '@claims/contracts';

import { apiRequest } from './client';

// Platform-admin tenant onboarding client. Gated server-side on the
// `tenant.create` permission, which the seeded platform_admin role
// carries.
export const TenantAdminApi = {
  list: (): Promise<TenantAdminListResponse> =>
    apiRequest<TenantAdminListResponse>('/admin/tenants'),

  detail: (tenantId: string): Promise<TenantAdminDetailResponse> =>
    apiRequest<TenantAdminDetailResponse>(
      `/admin/tenants/${encodeURIComponent(tenantId)}`,
    ),

  create: (body: CreateTenantRequest): Promise<CreateTenantResponse> =>
    apiRequest<CreateTenantResponse>('/admin/tenants', {
      method: 'POST',
      body,
    }),

  resendPrimaryInvite: (
    tenantId: string,
    userId: string,
  ): Promise<ResendPrimaryInviteResponse> =>
    apiRequest<ResendPrimaryInviteResponse>(
      `/admin/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}/resend-invite`,
      { method: 'POST' },
    ),
};
