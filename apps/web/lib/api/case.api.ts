import {
  type CaseDetail,
  type ClaimDecisionRequest,
  type ClaimDecisionResponse,
  type ClaimEventListResponse,
  type ClaimSubmissionResponse,
  type ClaimSubmissionSubmitRequest,
  type CreateCaseRequest,
  type DocumentListResponse,
  type EligibilityRequest,
  type EligibilityResponse,
  type ExpectPaymentRequest,
  type IntegrationMessageListResponse,
  type ListCasesResponse,
  type ManualTransitionRequest,
  type PreauthDecisionRequest,
  type PreauthDecisionResponse,
  type PreauthDraftRequest,
  type PreauthDraftResponse,
  type PreauthQueryResponseRequest,
  type PreauthSubmitResponse,
  type ReconcileRequest,
  type RecordReceiptRequest,
  type Settlement,
  type SettlementResponse,
  type UpdateCaseRequest,
  type UploadDocumentStubRequest,
  type UploadFinalizeRequest,
  type UploadInitRequest,
  type UploadInitResponse,
  type WriteOffRequest,
} from '@claims/contracts';

import { apiRequest } from './client';

export const CaseApi = {
  list: (params?: {
    limit?: number;
    offset?: number;
    status?: 'open' | 'closed' | 'abandoned';
  }): Promise<ListCasesResponse> => {
    const q = new URLSearchParams();
    if (params?.limit !== undefined) q.set('limit', String(params.limit));
    if (params?.offset !== undefined) q.set('offset', String(params.offset));
    if (params?.status) q.set('status', params.status);
    const query = q.toString();
    return apiRequest<ListCasesResponse>(`/cases${query ? `?${query}` : ''}`);
  },

  create: (body: CreateCaseRequest): Promise<CaseDetail> =>
    apiRequest<CaseDetail>('/cases', { method: 'POST', body }),

  getById: (id: string): Promise<CaseDetail> =>
    apiRequest<CaseDetail>(`/cases/${encodeURIComponent(id)}`),

  update: (id: string, body: UpdateCaseRequest): Promise<CaseDetail> =>
    apiRequest<CaseDetail>(`/cases/${encodeURIComponent(id)}`, { method: 'PATCH', body }),

  listClaimEvents: (caseId: string, claimId: string): Promise<ClaimEventListResponse> =>
    apiRequest<ClaimEventListResponse>(
      `/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(claimId)}/events`,
    ),

  manualTransition: (
    caseId: string,
    claimId: string,
    body: ManualTransitionRequest,
  ): Promise<{ status: string }> =>
    apiRequest<{ status: string }>(
      `/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(claimId)}/transitions`,
      { method: 'POST', body },
    ),

  runEligibility: (
    caseId: string,
    claimId: string,
    body: EligibilityRequest,
  ): Promise<EligibilityResponse> =>
    apiRequest<EligibilityResponse>(
      `/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(claimId)}/eligibility`,
      { method: 'POST', body },
    ),

  listIntegrationMessages: (
    caseId: string,
    claimId: string,
  ): Promise<IntegrationMessageListResponse> =>
    apiRequest<IntegrationMessageListResponse>(
      `/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(claimId)}/integration-messages`,
    ),

  getPreauthDraft: (
    caseId: string,
    claimId: string,
  ): Promise<PreauthDraftResponse | { draft: null }> =>
    apiRequest<PreauthDraftResponse | { draft: null }>(
      `/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(claimId)}/preauth/draft`,
    ),

  savePreauthDraft: (
    caseId: string,
    claimId: string,
    body: PreauthDraftRequest,
  ): Promise<PreauthDraftResponse> =>
    apiRequest<PreauthDraftResponse>(
      `/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(claimId)}/preauth/draft`,
      { method: 'PUT', body },
    ),

  submitPreauth: (caseId: string, claimId: string): Promise<PreauthSubmitResponse> =>
    apiRequest<PreauthSubmitResponse>(
      `/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(claimId)}/preauth/submit`,
      { method: 'POST', body: {} },
    ),

  preauthDecision: (
    caseId: string,
    claimId: string,
    body: PreauthDecisionRequest,
  ): Promise<PreauthDecisionResponse> =>
    apiRequest<PreauthDecisionResponse>(
      `/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(claimId)}/preauth/decision`,
      { method: 'POST', body },
    ),

  respondPreauthQuery: (
    caseId: string,
    claimId: string,
    queryId: string,
    body: PreauthQueryResponseRequest,
  ): Promise<{ status: string }> =>
    apiRequest<{ status: string }>(
      `/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(claimId)}/preauth/queries/${encodeURIComponent(queryId)}/respond`,
      { method: 'POST', body },
    ),

  listDocuments: (caseId: string, claimId: string): Promise<DocumentListResponse> =>
    apiRequest<DocumentListResponse>(
      `/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(claimId)}/documents`,
    ),

  uploadDocumentStub: (
    caseId: string,
    claimId: string,
    body: UploadDocumentStubRequest,
  ): Promise<{ document: DocumentListResponse['documents'][number] }> =>
    apiRequest<{ document: DocumentListResponse['documents'][number] }>(
      `/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(claimId)}/documents/upload-stub`,
      { method: 'POST', body },
    ),

  uploadInit: (
    caseId: string,
    claimId: string,
    body: UploadInitRequest,
  ): Promise<UploadInitResponse> =>
    apiRequest<UploadInitResponse>(
      `/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(claimId)}/documents/upload-init`,
      { method: 'POST', body },
    ),

  uploadFinalize: (
    caseId: string,
    claimId: string,
    documentId: string,
    body: UploadFinalizeRequest = {},
  ): Promise<{ document: DocumentListResponse['documents'][number] }> =>
    apiRequest<{ document: DocumentListResponse['documents'][number] }>(
      `/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(claimId)}/documents/${encodeURIComponent(documentId)}/finalize`,
      { method: 'POST', body },
    ),

  initiateDischarge: (caseId: string, claimId: string): Promise<{ status: string }> =>
    apiRequest<{ status: string }>(
      `/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(claimId)}/discharge/initiate`,
      { method: 'POST', body: {} },
    ),

  submitDischarge: (caseId: string, claimId: string): Promise<{ status: string }> =>
    apiRequest<{ status: string }>(
      `/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(claimId)}/discharge/submit`,
      { method: 'POST', body: {} },
    ),

  startClaimSubmission: (caseId: string, claimId: string): Promise<{ status: string }> =>
    apiRequest<{ status: string }>(
      `/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(claimId)}/claim-submission/start`,
      { method: 'POST', body: {} },
    ),

  submitClaim: (
    caseId: string,
    claimId: string,
    body: ClaimSubmissionSubmitRequest,
  ): Promise<ClaimSubmissionResponse> =>
    apiRequest<ClaimSubmissionResponse>(
      `/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(claimId)}/claim-submission/submit`,
      { method: 'POST', body },
    ),

  claimDecision: (
    caseId: string,
    claimId: string,
    body: ClaimDecisionRequest,
  ): Promise<ClaimDecisionResponse> =>
    apiRequest<ClaimDecisionResponse>(
      `/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(claimId)}/claim-submission/decision`,
      { method: 'POST', body },
    ),

  getSettlement: (caseId: string, claimId: string): Promise<{ settlement: Settlement | null }> =>
    apiRequest<{ settlement: Settlement | null }>(
      `/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(claimId)}/settlement`,
    ),

  expectPayment: (
    caseId: string,
    claimId: string,
    body: ExpectPaymentRequest,
  ): Promise<SettlementResponse> =>
    apiRequest<SettlementResponse>(
      `/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(claimId)}/settlement/expect`,
      { method: 'POST', body },
    ),

  recordReceipt: (
    caseId: string,
    claimId: string,
    body: RecordReceiptRequest,
  ): Promise<SettlementResponse> =>
    apiRequest<SettlementResponse>(
      `/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(claimId)}/settlement/receipt`,
      { method: 'POST', body },
    ),

  reconcile: (
    caseId: string,
    claimId: string,
    body: ReconcileRequest,
  ): Promise<SettlementResponse> =>
    apiRequest<SettlementResponse>(
      `/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(claimId)}/settlement/reconcile`,
      { method: 'POST', body },
    ),

  writeOffSettlement: (
    caseId: string,
    claimId: string,
    body: WriteOffRequest,
  ): Promise<SettlementResponse> =>
    apiRequest<SettlementResponse>(
      `/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(claimId)}/settlement/write-off`,
      { method: 'POST', body },
    ),

  closeSettlement: (caseId: string, claimId: string): Promise<SettlementResponse> =>
    apiRequest<SettlementResponse>(
      `/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(claimId)}/settlement/close`,
      { method: 'POST', body: {} },
    ),
};
