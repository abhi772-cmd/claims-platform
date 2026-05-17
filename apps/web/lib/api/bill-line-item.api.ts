import {
  type BillLineItemsListResponse,
  type SaveBillLineItemsRequest,
} from '@claims/contracts';

import { apiRequest } from './client';

// T2-13 follow-up — persisted bill line items.
//   list — GET, returns lines + server-computed totals
//   save — POST, replace-all semantics (server clears + inserts)
export const BillLineItemApi = {
  list: (caseId: string, claimId: string): Promise<BillLineItemsListResponse> =>
    apiRequest<BillLineItemsListResponse>(
      `/cases/${caseId}/claims/${claimId}/bill-line-items`,
    ),

  save: (
    caseId: string,
    claimId: string,
    body: SaveBillLineItemsRequest,
  ): Promise<BillLineItemsListResponse> =>
    apiRequest<BillLineItemsListResponse>(
      `/cases/${caseId}/claims/${claimId}/bill-line-items`,
      { method: 'POST', body },
    ),
};
