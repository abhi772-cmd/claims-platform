// Phase 2 — ABDM ABHA creation client. Two-step Aadhaar OTP flow:
//
//   POST /abha/init    Aadhaar -> ABDM sends OTP to Aadhaar-registered mobile
//   POST /abha/verify  txnId + OTP -> ABDM returns a fresh ABHA
//
// Stub mode (ABHA_CREATION_MODE=stub on the API) drives the demo:
//   * OTP is always 123456
//   * Aadhaar prefix 000000 -> init rejects ("no mobile linked")
//   * Aadhaar prefix 999999 -> verify rejects ("OTP mismatch")
//   * any other 12-digit Aadhaar -> happy path; ABHA derived from suffix

import {
  type AbhaCreateInitRequest,
  type AbhaCreateInitResponse,
  type AbhaCreateVerifyRequest,
  type AbhaCreateVerifyResponse,
} from '@claims/contracts';

import { apiRequest } from './client';

export const AbhaCreationApi = {
  init: (body: AbhaCreateInitRequest): Promise<AbhaCreateInitResponse> =>
    apiRequest<AbhaCreateInitResponse>('/abha/init', {
      method: 'POST',
      body,
    }),

  verify: (body: AbhaCreateVerifyRequest): Promise<AbhaCreateVerifyResponse> =>
    apiRequest<AbhaCreateVerifyResponse>('/abha/verify', {
      method: 'POST',
      body,
    }),
} as const;
