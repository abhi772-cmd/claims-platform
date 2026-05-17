import { type InsurancePlanResponse } from '@claims/contracts';

import { apiRequest } from './client';

// Insurance-plan summary client. Read-only — the data is
// composed from existing rows (case + claim + eligibility event)
// at read time; no persistence layer to mutate.
export const InsurancePlanApi = {
  get: (caseId: string, claimId: string): Promise<InsurancePlanResponse> =>
    apiRequest<InsurancePlanResponse>(
      `/cases/${caseId}/claims/${claimId}/insurance-plan`,
    ),
};
