import {
  type BillingCodeListResponse,
  type ChecklistAdmissionType,
  type ChecklistPhase,
  type CreateDocumentChecklistRuleRequest,
  type CreatePackageRequest,
  type CreatePayerRequest,
  type DocumentChecklistRule,
  type DocumentChecklistRuleListResponse,
  type IcdCodeListResponse,
  type Package,
  type PackageListResponse,
  type Payer,
  type PayerListResponse,
  type PayerRail,
  type ResolvedChecklistResponse,
  type UpdateDocumentChecklistRuleRequest,
  type UpdatePackageRequest,
  type UpdatePayerRequest,
} from '@claims/contracts';

import { apiRequest } from './client';

const qs = (params: Record<string, string | number | boolean | undefined>): string => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
};

export const MasterDataApi = {
  // Payer
  listPayers: (params?: {
    rail?: PayerRail;
    active?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<PayerListResponse> =>
    apiRequest<PayerListResponse>(`/payers${qs(params ?? {})}`),

  getPayer: (id: string): Promise<{ payer: Payer }> =>
    apiRequest<{ payer: Payer }>(`/payers/${encodeURIComponent(id)}`),

  createPayer: (body: CreatePayerRequest): Promise<{ payer: Payer }> =>
    apiRequest<{ payer: Payer }>('/payers', { method: 'POST', body }),

  updatePayer: (id: string, body: UpdatePayerRequest): Promise<{ payer: Payer }> =>
    apiRequest<{ payer: Payer }>(`/payers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body,
    }),

  // Package
  listPackages: (params?: {
    // Typeahead search over package code + name (D-023 picker).
    q?: string;
    category?: string;
    pmjayHbp?: boolean;
    active?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<PackageListResponse> =>
    apiRequest<PackageListResponse>(`/packages${qs(params ?? {})}`),

  createPackage: (body: CreatePackageRequest): Promise<{ package: Package }> =>
    apiRequest<{ package: Package }>('/packages', { method: 'POST', body }),

  updatePackage: (id: string, body: UpdatePackageRequest): Promise<{ package: Package }> =>
    apiRequest<{ package: Package }>(`/packages/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body,
    }),

  // ICD codes
  listIcd: (params?: {
    q?: string;
    active?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<IcdCodeListResponse> =>
    apiRequest<IcdCodeListResponse>(`/icd-codes${qs(params ?? {})}`),

  // Billing codes
  listBilling: (params?: {
    category?: string;
    active?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<BillingCodeListResponse> =>
    apiRequest<BillingCodeListResponse>(`/billing-codes${qs(params ?? {})}`),

  // Document checklist rules
  listChecklistRules: (params?: {
    phase?: ChecklistPhase;
    rail?: PayerRail;
    active?: boolean;
  }): Promise<DocumentChecklistRuleListResponse> =>
    apiRequest<DocumentChecklistRuleListResponse>(
      `/document-checklist-rules${qs(params ?? {})}`,
    ),

  createChecklistRule: (
    body: CreateDocumentChecklistRuleRequest,
  ): Promise<{ rule: DocumentChecklistRule }> =>
    apiRequest<{ rule: DocumentChecklistRule }>('/document-checklist-rules', {
      method: 'POST',
      body,
    }),

  updateChecklistRule: (
    id: string,
    body: UpdateDocumentChecklistRuleRequest,
  ): Promise<{ rule: DocumentChecklistRule }> =>
    apiRequest<{ rule: DocumentChecklistRule }>(
      `/document-checklist-rules/${encodeURIComponent(id)}`,
      { method: 'PATCH', body },
    ),

  resolveChecklist: (params: {
    phase: ChecklistPhase;
    rail: PayerRail;
    payerCode?: string;
    packageCode?: string;
    admissionType?: ChecklistAdmissionType;
  }): Promise<ResolvedChecklistResponse> =>
    apiRequest<ResolvedChecklistResponse>(
      `/document-checklist-rules/resolve${qs(params)}`,
    ),
};
