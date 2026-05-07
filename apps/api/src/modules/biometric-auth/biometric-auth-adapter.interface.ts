// Slice BF — ABDM biometric authentication adapter. PMJAY mandates
// Aadhaar biometric (or face / iris) verification before preauth and
// before discharge / claim submission. ABDM exposes a three-call
// flow at https://apisbx.abdm.gov.in/hcx/abha/biometric/auth/{init,
// verify, refresh/token} that we wrap behind this adapter.
//
// Three modes via BIOMETRIC_AUTH_MODE:
//   off  — DisabledBiometricAuthAdapter: every call returns
//          'disabled'. Non-PMJAY tenants don't pay the integration
//          tax. Default mode.
//   stub — StubBiometricAuthAdapter: deterministic in-process pass
//          (with an env-driven failure list for negative-path tests).
//          Lets integration tests exercise the gate-on-biometric
//          flow without an ABDM sandbox account.
//   real — HttpBiometricAuthAdapter: actual HTTPS calls to ABDM.
//          Bound when BIOMETRIC_AUTH_MODE=real. Requires
//          BIOMETRIC_AUTH_BASE_URL to be set (boot-time check).
//
// Slice BG will gate preauth + claim submission on this adapter for
// PMJAY-mode tenants. Other tenants stay on the disabled path.

export const BIOMETRIC_AUTH_ADAPTER = Symbol('BIOMETRIC_AUTH_ADAPTER');

// authMode + scope are tightly coupled per the ABDM contract — pass
// FINGERPRINT with aadhaar-bio-verify, FACE_AUTH with aadhaar-face-verify,
// IRIS with aadhaar-iris-verify. The caller decides based on what the
// hospital's biometric device supports + what the beneficiary
// consented to.
export type BiometricAuthMode = 'FINGERPRINT' | 'IRIS' | 'FACE_AUTH';
export type BiometricAuthScope =
  | 'aadhaar-bio-verify'
  | 'aadhaar-face-verify'
  | 'aadhaar-iris-verify';

// PMJAY runs the verify twice per case: once before preauth and once
// before discharge / claim submit. ABDM uses the `process` header to
// route the call to the right downstream auditor.
export type BiometricProcess = 'Preauth' | 'Discharge';

// Login hint matches what the operator entered first — usually the
// beneficiary's PMJAY card → ABHA number, but mobile and Aadhaar are
// also valid. ABDM validates the loginId format against the hint.
export type BiometricLoginHint = 'abha-number' | 'mobile' | 'aadhaar';

export interface BiometricInitInput {
  scope: BiometricAuthScope;
  loginHint: BiometricLoginHint;
  loginId: string;
  authMode: BiometricAuthMode;
  process: BiometricProcess;
  // PMJAY payer NHCX participant id — ABDM uses this to route the
  // verification audit log back to the right payer's instance.
  payerId: string;
  // Outer ABHA-platform bearer token (the platform-level JWT we
  // already obtain for ABDM HPR / patient-link flows). Plumbed in
  // by the caller; this adapter does not mint or refresh it.
  bearerToken: string;
}

export interface BiometricInitResult {
  status: 'init_ok' | 'failed' | 'disabled';
  // Returned by ABDM on init_ok. Echoed back into verify so ABDM can
  // tie the two halves of the auth dance together.
  txnId?: string;
  // Free-form on failed. The caller surfaces this on the operator
  // screen so they can retry / pick a different auth mode / abandon
  // the session if the device is unreachable.
  error?: string;
}

// authData contains the device-captured PID block. Exactly one of
// fingerPrintAuthPid / faceAuthPid / irisAuthPid must be present and
// must match the authMode chosen at init. The PID block itself is
// device-encrypted and we treat it as opaque — we never log it.
export interface BiometricVerifyInput {
  scope: BiometricAuthScope;
  authMode: BiometricAuthMode;
  authData: {
    txnId: string;
    fingerPrintAuthPid?: string;
    faceAuthPid?: string;
    irisAuthPid?: string;
  };
  process: BiometricProcess;
  payerId: string;
  bearerToken: string;
}

export interface BiometricVerifyResult {
  status: 'verified' | 'failed' | 'disabled';
  // ABHA token issued by ABDM on verified. Embedded into the FHIR
  // Bundle's authentication extension on the next preauth / claim
  // submission so the payer can confirm the beneficiary was
  // biometrically verified.
  authToken?: string;
  // Long-lived refresh handle so a single biometric capture covers
  // both Preauth and Discharge processes without re-prompting the
  // beneficiary on the same admission.
  refreshToken?: string;
  // Free-form on failed.
  error?: string;
}

export interface BiometricRefreshInput {
  bearerToken: string;
  refreshToken: string;
  process: BiometricProcess;
  payerId: string;
}

export interface BiometricRefreshResult {
  status: 'refreshed' | 'failed' | 'disabled';
  authToken?: string;
  error?: string;
}

export interface BiometricAuthAdapter {
  init(input: BiometricInitInput): Promise<BiometricInitResult>;
  verify(input: BiometricVerifyInput): Promise<BiometricVerifyResult>;
  refreshToken(input: BiometricRefreshInput): Promise<BiometricRefreshResult>;
}
