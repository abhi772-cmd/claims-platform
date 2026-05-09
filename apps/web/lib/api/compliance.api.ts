import { type ComplianceDashboard } from '@claims/contracts';

import { apiRequest } from './client';

export const ComplianceApi = {
  dashboard: (): Promise<ComplianceDashboard> =>
    apiRequest<ComplianceDashboard>('/admin/compliance/dashboard'),
};
