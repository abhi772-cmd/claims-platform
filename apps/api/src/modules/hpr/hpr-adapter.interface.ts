// ABDM HPR adapter contract. Two implementations:
//   HprStubAdapter — env-driven allowlist + fixed OTP, no external HTTP.
//   HprRealAdapter — calls ABDM Sandbox APIs (OAuth2 client_credentials
//                    → /api/v1/auth/init → /api/v1/auth/confirmWithMobileOTP
//                    → /api/v2/hpr/healthcareprofessional/{hprId}).
//
// The doctor-sign flow is two-step in real ABDM:
//   1. requestOtp(hprId): triggers SMS to the doctor's registered mobile,
//      returns a transactionId we must hand back to confirm.
//   2. verifyOtp(hprId, txId, otp): validates the OTP against the txn
//      and looks up the profile.
//
// The stub keeps backwards compatibility: txId may be omitted, in which
// case the OTP is checked directly against the configured stub OTP.

export const HPR_ADAPTER = Symbol('HPR_ADAPTER');

export interface HprVerification {
  hprId: string;
  fullName: string;
  registrationActive: boolean;
}

export interface HprOtpRequestResult {
  transactionId: string;
  expiresAt: string;
}

export interface HprAdapter {
  // Step 1: request that ABDM send an OTP to the doctor's mobile. The
  // returned transactionId must be passed back into verifyOtp. In stub
  // mode this is a no-op — the stub returns a synthetic txn id and the
  // caller can verify against the configured stub OTP.
  requestOtp(hprId: string): Promise<HprOtpRequestResult>;

  // Step 2: verify the OTP (and, in real mode, the transaction id) and
  // return the doctor's HPR profile. Throws HprVerificationFailedError
  // on any failure — callers should not differentiate "wrong OTP" from
  // "wrong HPR" or any other variant (D-014).
  verifyOtp(input: {
    hprId: string;
    otp: string;
    transactionId?: string;
  }): Promise<HprVerification>;
}
