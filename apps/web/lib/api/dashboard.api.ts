import { type OperationalDashboardResponse } from '@claims/contracts';

import { apiRequest } from './client';

// Operational dashboard client. Distinct from ComplianceApi
// (which serves the governance dashboard at /admin/compliance) —
// this one feeds the operational tiles on the landing page.
export const DashboardApi = {
  operational: (): Promise<OperationalDashboardResponse> =>
    apiRequest<OperationalDashboardResponse>('/dashboard/operational'),
};
