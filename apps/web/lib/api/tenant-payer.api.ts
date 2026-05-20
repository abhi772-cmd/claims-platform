// Slice CN — tenant ↔ payer empanelment client.
//
// The payer registry (MasterDataApi) is superadmin-curated; this
// client is the tenant-facing empanelment surface. Case-creation
// payer dropdowns read `listEmpanelled` (active only); the empanelment
// admin page reads `listAvailable` (registry + empanelled flag).

import {
  type AvailablePayerListResponse,
  type EmpanelledPayer,
  type EmpanelledPayerListResponse,
} from '@claims/contracts';

import { apiRequest } from './client';

export const TenantPayerApi = {
  // Active empanelled payers — what the case dropdown shows.
  listEmpanelled: (): Promise<EmpanelledPayerListResponse> =>
    apiRequest<EmpanelledPayerListResponse>('/tenant/payers'),

  // Includes retired empanelments — for the admin page.
  listAll: (): Promise<EmpanelledPayerListResponse> =>
    apiRequest<EmpanelledPayerListResponse>('/tenant/payers/all'),

  // Full registry annotated with this tenant's empanelled flag.
  listAvailable: (): Promise<AvailablePayerListResponse> =>
    apiRequest<AvailablePayerListResponse>('/tenant/payers/available'),

  empanel: (payerId: string): Promise<EmpanelledPayer> =>
    apiRequest<EmpanelledPayer>('/tenant/payers', {
      method: 'POST',
      body: { payerId },
    }),

  setActive: (payerId: string, active: boolean): Promise<EmpanelledPayer> =>
    apiRequest<EmpanelledPayer>(`/tenant/payers/${encodeURIComponent(payerId)}`, {
      method: 'PATCH',
      body: { active },
    }),
} as const;
