import {
  type RemittanceBatchRequest,
  type RemittanceBatchResponse,
} from '@claims/contracts';

import { apiRequest } from './client';

export const RemittanceApi = {
  processBatch: (body: RemittanceBatchRequest): Promise<RemittanceBatchResponse> =>
    apiRequest<RemittanceBatchResponse>('/settlement/remittance', {
      method: 'POST',
      body,
    }),
};
