import {
  type CompleteOnboardingStepRequest,
  type KycDocument,
  type KycDownloadResponse,
  type KycListResponse,
  type KycUploadFinalizeRequest,
  type KycUploadInitRequest,
  type KycUploadInitResponse,
  type LifecycleStateResponse,
  type LifecycleTransitionRequest,
  type OnboardingStep,
  type OnboardingStepKey,
  type OnboardingStepsResponse,
  type ReadinessReport,
  type TenantProfile,
  type TenantProfileUpdate,
} from '@claims/contracts';

import { apiRequest } from './client';

export const TenantApi = {
  listOnboardingSteps: (): Promise<OnboardingStepsResponse> =>
    apiRequest<OnboardingStepsResponse>('/tenant/onboarding/steps'),

  completeOnboardingStep: (
    key: OnboardingStepKey,
    body: CompleteOnboardingStepRequest,
  ): Promise<OnboardingStep> =>
    apiRequest<OnboardingStep>(
      `/tenant/onboarding/steps/${encodeURIComponent(key)}/complete`,
      { method: 'POST', body },
    ),

  runReadiness: (): Promise<ReadinessReport> =>
    apiRequest<ReadinessReport>('/tenant/readiness'),

  getLifecycle: (): Promise<LifecycleStateResponse> =>
    apiRequest<LifecycleStateResponse>('/tenant/lifecycle'),

  transitionLifecycle: (body: LifecycleTransitionRequest): Promise<LifecycleStateResponse> =>
    apiRequest<LifecycleStateResponse>('/tenant/lifecycle/transition', {
      method: 'POST',
      body,
    }),

  getProfile: (): Promise<TenantProfile> =>
    apiRequest<TenantProfile>('/tenant/profile'),

  patchProfile: (body: TenantProfileUpdate): Promise<TenantProfile> =>
    apiRequest<TenantProfile>('/tenant/profile', { method: 'PATCH', body }),

  listKyc: (): Promise<KycListResponse> =>
    apiRequest<KycListResponse>('/tenant/kyc'),

  kycUploadInit: (body: KycUploadInitRequest): Promise<KycUploadInitResponse> =>
    apiRequest<KycUploadInitResponse>('/tenant/kyc/upload-init', {
      method: 'POST',
      body,
    }),

  kycFinalize: (documentId: string, body: KycUploadFinalizeRequest): Promise<KycDocument> =>
    apiRequest<KycDocument>(
      `/tenant/kyc/${encodeURIComponent(documentId)}/finalize`,
      { method: 'POST', body },
    ),

  kycDelete: (documentId: string): Promise<void> =>
    apiRequest<void>(`/tenant/kyc/${encodeURIComponent(documentId)}`, {
      method: 'DELETE',
    }),

  kycDownloadUrl: (documentId: string): Promise<KycDownloadResponse> =>
    apiRequest<KycDownloadResponse>(
      `/tenant/kyc/${encodeURIComponent(documentId)}/download-url`,
    ),
};
