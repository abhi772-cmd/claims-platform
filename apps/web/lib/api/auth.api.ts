import {
  type ChangePasswordRequest,
  type LoginRequest,
  type LoginResponse,
  type MeResponse,
  type PasswordPolicyDescriptor,
  type PasswordResetCompleteRequest,
  type PasswordResetInitiateRequest,
  type PasswordResetVerifyResponse,
} from '@claims/contracts';

import { apiRequest } from './client';

export const AuthApi = {
  login: (body: LoginRequest): Promise<LoginResponse> =>
    apiRequest<LoginResponse>('/auth/login', { method: 'POST', body }),

  me: (signal?: AbortSignal): Promise<MeResponse> =>
    apiRequest<MeResponse>('/auth/me', signal ? { signal } : {}),

  logout: (): Promise<void> => apiRequest<void>('/auth/logout', { method: 'POST' }),

  passwordPolicy: (signal?: AbortSignal): Promise<PasswordPolicyDescriptor> =>
    apiRequest<PasswordPolicyDescriptor>('/auth/password-policy', signal ? { signal } : {}),

  initiatePasswordReset: (body: PasswordResetInitiateRequest): Promise<void> =>
    apiRequest<void>('/auth/password-reset/initiate', { method: 'POST', body }),

  verifyPasswordReset: (token: string, signal?: AbortSignal): Promise<PasswordResetVerifyResponse> =>
    apiRequest<PasswordResetVerifyResponse>(
      `/auth/password-reset/verify?token=${encodeURIComponent(token)}`,
      signal ? { signal } : {},
    ),

  completePasswordReset: (body: PasswordResetCompleteRequest): Promise<void> =>
    apiRequest<void>('/auth/password-reset/complete', { method: 'POST', body }),

  changePassword: (body: ChangePasswordRequest): Promise<void> =>
    apiRequest<void>('/auth/me/password', { method: 'POST', body }),
};
