import {
  type ChangePasswordRequest,
  type IpAllowlist,
  type LoginMfaChallengeResponse,
  type LoginRequest,
  type LoginResponse,
  type MeResponse,
  type MfaConfirmRequest,
  type MfaConfirmResponse,
  type MfaDisableRequest,
  type MfaRegenerateBackupCodesRequest,
  type MfaRegenerateBackupCodesResponse,
  type MfaSetupResponse,
  type MfaVerifyRequest,
  type PasswordPolicyDescriptor,
  type PasswordResetCompleteRequest,
  type PasswordResetInitiateRequest,
  type PasswordResetVerifyResponse,
  type SessionListResponse,
  type TrustedDeviceListResponse,
} from '@claims/contracts';

import { apiRequest } from './client';

export const AuthApi = {
  login: (body: LoginRequest): Promise<LoginResponse | LoginMfaChallengeResponse> =>
    apiRequest<LoginResponse | LoginMfaChallengeResponse>('/auth/login', {
      method: 'POST',
      body,
    }),

  mfaVerify: (body: MfaVerifyRequest): Promise<LoginResponse> =>
    apiRequest<LoginResponse>('/auth/mfa/verify', { method: 'POST', body }),

  mfaSetup: (): Promise<MfaSetupResponse> =>
    apiRequest<MfaSetupResponse>('/auth/me/mfa/setup', { method: 'POST' }),

  mfaConfirm: (body: MfaConfirmRequest): Promise<MfaConfirmResponse> =>
    apiRequest<MfaConfirmResponse>('/auth/me/mfa/confirm', { method: 'POST', body }),

  mfaDisable: (body: MfaDisableRequest): Promise<void> =>
    apiRequest<void>('/auth/me/mfa/disable', { method: 'POST', body }),

  mfaRegenerateBackupCodes: (
    body: MfaRegenerateBackupCodesRequest,
  ): Promise<MfaRegenerateBackupCodesResponse> =>
    apiRequest<MfaRegenerateBackupCodesResponse>('/auth/me/mfa/backup-codes/regenerate', {
      method: 'POST',
      body,
    }),

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

  listSessions: (): Promise<SessionListResponse> =>
    apiRequest<SessionListResponse>('/auth/me/sessions'),

  revokeSession: (id: string): Promise<void> =>
    apiRequest<void>(`/auth/me/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  listTrustedDevices: (): Promise<TrustedDeviceListResponse> =>
    apiRequest<TrustedDeviceListResponse>('/auth/me/trusted-devices'),

  revokeTrustedDevice: (id: string): Promise<void> =>
    apiRequest<void>(`/auth/me/trusted-devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  getIpAllowlist: (): Promise<IpAllowlist> =>
    apiRequest<IpAllowlist>('/tenant/security/ip-allowlist'),

  updateIpAllowlist: (body: IpAllowlist): Promise<IpAllowlist> =>
    apiRequest<IpAllowlist>('/tenant/security/ip-allowlist', { method: 'PUT', body }),
};
