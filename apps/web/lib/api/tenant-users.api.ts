import { type ListTenantUsersResponse } from '@claims/contracts';

import { apiRequest } from './client';

// Admin /tenant/users directory client. Read-only for now; mutate
// operations (resend invite) live on the invite client because
// they predate this directory slice.
export const TenantUsersApi = {
  list: (): Promise<ListTenantUsersResponse> =>
    apiRequest<ListTenantUsersResponse>('/tenant/users'),

  resendInvite: (userId: string): Promise<{ inviteExpiresAt: string }> =>
    apiRequest<{ inviteExpiresAt: string }>(
      `/tenant/users/${userId}/resend-invite`,
      { method: 'POST' },
    ),
};
