// Phase 2 — ABDM ABHA creation adapter contract. Three implementations
// pluggable via ABHA_CREATION_MODE:
//
//   * stub      deterministic fixtures — used in dev + CI + the
//               demo walkthrough so the OTP flow is exercisable
//               without ABDM credentials
//   * http      real ABDM v3 /profile/account/aadhaar/{sendOtp,verifyOtp}
//               (lands when a hospital has ABDM client credentials)
//   * disabled  every call rejects — used when the deployment can't
//               legally issue ABHAs (e.g. tenant hasn't passed ABDM KYC)

import {
  type AbhaCreateInitResponse,
  type AbhaCreateVerifyResponse,
} from '@claims/contracts';

export const ABHA_CREATION_ADAPTER = Symbol.for('AbhaCreationAdapter');

export interface AbhaInitInput {
  tenantId: string;
  aadhaar: string;
}

export interface AbhaVerifyInput {
  tenantId: string;
  txnId: string;
  otp: string;
}

export interface AbhaCreationAdapter {
  init(input: AbhaInitInput): Promise<AbhaCreateInitResponse>;
  verify(input: AbhaVerifyInput): Promise<AbhaCreateVerifyResponse>;
}
