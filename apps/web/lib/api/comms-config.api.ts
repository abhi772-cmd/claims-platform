import {
  type TenantCommsConfig,
  type TenantCommsConfigSummary,
} from '@claims/contracts';

import { apiRequest } from './client';

export const CommsConfigApi = {
  get: (): Promise<TenantCommsConfigSummary> =>
    apiRequest<TenantCommsConfigSummary>('/tenant/comms-config'),

  patch: (body: TenantCommsConfig): Promise<TenantCommsConfigSummary> =>
    apiRequest<TenantCommsConfigSummary>('/tenant/comms-config', {
      method: 'PATCH',
      body,
    }),
};
