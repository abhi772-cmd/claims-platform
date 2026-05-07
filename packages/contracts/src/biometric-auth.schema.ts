// Slice BG — public request / response shapes for the case-scoped
// biometric auth endpoints. The adapter contract sits inside the API
// (apps/api/src/modules/biometric-auth/) — these are the wire shapes
// for the web app.

import { z } from 'zod';

export const BiometricAuthModeSchema = z.enum(['FINGERPRINT', 'IRIS', 'FACE_AUTH']);
export type BiometricAuthMode = z.infer<typeof BiometricAuthModeSchema>;

export const BiometricAuthScopeSchema = z.enum([
  'aadhaar-bio-verify',
  'aadhaar-face-verify',
  'aadhaar-iris-verify',
]);
export type BiometricAuthScope = z.infer<typeof BiometricAuthScopeSchema>;

export const BiometricLoginHintSchema = z.enum(['abha-number', 'mobile', 'aadhaar']);
export type BiometricLoginHint = z.infer<typeof BiometricLoginHintSchema>;

export const BiometricProcessSchema = z.enum(['Preauth', 'Discharge']);
export type BiometricProcess = z.infer<typeof BiometricProcessSchema>;

export const BiometricInitRequestSchema = z.object({
  scope: BiometricAuthScopeSchema,
  loginHint: BiometricLoginHintSchema,
  // ABHA / mobile / Aadhaar — never logged. The API hashes this
  // before persisting on a successful verify.
  loginId: z.string().min(1).max(64),
  authMode: BiometricAuthModeSchema,
  process: BiometricProcessSchema,
  // PMJAY payer NHCX participant id.
  payerId: z.string().min(1).max(128),
  // Outer ABHA-platform JWT — the caller plumbs this in from a
  // separate flow; the biometric service does not mint it.
  bearerToken: z.string().min(1),
});
export type BiometricInitRequest = z.infer<typeof BiometricInitRequestSchema>;

export const BiometricInitResponseSchema = z.object({
  status: z.enum(['init_ok', 'disabled']),
  txnId: z.string().optional(),
});
export type BiometricInitResponse = z.infer<typeof BiometricInitResponseSchema>;

export const BiometricVerifyRequestSchema = z.object({
  scope: BiometricAuthScopeSchema,
  authMode: BiometricAuthModeSchema,
  loginHint: BiometricLoginHintSchema,
  loginId: z.string().min(1).max(64),
  authData: z.object({
    txnId: z.string().min(1),
    // Exactly one of these three must be present and must match the
    // authMode chosen at init. Server-side validation enforces the
    // invariant; client errors get a clean 422.
    fingerPrintAuthPid: z.string().min(1).optional(),
    faceAuthPid: z.string().min(1).optional(),
    irisAuthPid: z.string().min(1).optional(),
  }),
  process: BiometricProcessSchema,
  payerId: z.string().min(1).max(128),
  bearerToken: z.string().min(1),
});
export type BiometricVerifyRequest = z.infer<typeof BiometricVerifyRequestSchema>;

export const BiometricVerifyResponseSchema = z.object({
  status: z.enum(['verified', 'disabled']),
  verificationId: z.string().uuid().optional(),
  verifiedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
});
export type BiometricVerifyResponse = z.infer<typeof BiometricVerifyResponseSchema>;
