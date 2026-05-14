import {
  type InsurancePlanLookup,
  type InsurancePlanRequest,
  type InsurancePlanRequestResponse,
} from '@claims/contracts';

import { ApiError, apiRequest } from './client';

// Web client for the `insuranceplan/request` chain-root operation.
// Mirrors apps/api/src/modules/insurance-plan/insurance-plan.controller.ts.
//
// `getForClaim` resolves to `null` on a 404 — the controller returns
// 404 for "no lookup triggered yet" specifically so the UI can show
// the lookup form instead of an error modal. Any other failure
// (auth, 5xx, …) is re-thrown for the caller to surface.

export const InsurancePlanApi = {
  /** Kick off a lookup tied to an in-flight claim. */
  lookupForClaim: (
    caseId: string,
    claimId: string,
    body: InsurancePlanRequest,
  ): Promise<InsurancePlanRequestResponse> =>
    apiRequest<InsurancePlanRequestResponse>(
      `/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(claimId)}/insurance-plan/lookup`,
      { method: 'POST', body },
    ),

  /** Freestanding lookup (pre-admission OPD flow — nothing stamped). */
  lookup: (body: InsurancePlanRequest): Promise<InsurancePlanRequestResponse> =>
    apiRequest<InsurancePlanRequestResponse>('/insurance-plan/lookup', {
      method: 'POST',
      body,
    }),

  /**
   * Latest lookup row for a claim. Returns `null` when no lookup has
   * been triggered yet (the controller's 404 case); throws on any
   * other error.
   */
  getForClaim: async (
    caseId: string,
    claimId: string,
    signal?: AbortSignal,
  ): Promise<InsurancePlanLookup | null> => {
    try {
      return await apiRequest<InsurancePlanLookup>(
        `/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(claimId)}/insurance-plan`,
        { signal },
      );
    } catch (err) {
      if (err instanceof ApiError && err.problem.status === 404) return null;
      throw err;
    }
  },

  /** Direct correlation-id read (freestanding lookup). `null` on 404. */
  getByCorrelationId: async (
    correlationId: string,
    signal?: AbortSignal,
  ): Promise<InsurancePlanLookup | null> => {
    try {
      return await apiRequest<InsurancePlanLookup>(
        `/insurance-plan/lookups/${encodeURIComponent(correlationId)}`,
        { signal },
      );
    } catch (err) {
      if (err instanceof ApiError && err.problem.status === 404) return null;
      throw err;
    }
  },
};
