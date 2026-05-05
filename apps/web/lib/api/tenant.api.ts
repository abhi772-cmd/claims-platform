import {
  type CompleteOnboardingStepRequest,
  type LifecycleStateResponse,
  type LifecycleTransitionRequest,
  type OnboardingStep,
  type OnboardingStepKey,
  type OnboardingStepsResponse,
  type ReadinessReport,
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
};
