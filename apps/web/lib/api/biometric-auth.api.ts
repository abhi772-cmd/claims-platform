// Case-scoped BIS biometric auth client. Two-step ABHA biometric:
//   POST /cases/:caseId/biometric-auth/init    → returns txnId
//   POST /cases/:caseId/biometric-auth/verify  → returns verificationId
//
// PMJAY mandates BIS verification at admission alongside ABHA/Aadhaar.
// The biometric service is mode-gated (BIOMETRIC_AUTH_MODE=stub|http|
// disabled). In disabled mode both endpoints return { status: 'disabled' }
// so the UI can degrade to an OTP fallback.

import {
  type BiometricInitRequest,
  type BiometricInitResponse,
  type BiometricVerifyRequest,
  type BiometricVerifyResponse,
} from '@claims/contracts';

import { apiRequest } from './client';

export const BiometricAuthApi = {
  init: (caseId: string, body: BiometricInitRequest): Promise<BiometricInitResponse> =>
    apiRequest<BiometricInitResponse>(`/cases/${caseId}/biometric-auth/init`, {
      method: 'POST',
      body,
    }),

  verify: (caseId: string, body: BiometricVerifyRequest): Promise<BiometricVerifyResponse> =>
    apiRequest<BiometricVerifyResponse>(`/cases/${caseId}/biometric-auth/verify`, {
      method: 'POST',
      body,
    }),
} as const;
