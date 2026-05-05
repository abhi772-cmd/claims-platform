import { z } from 'zod';

// Scope of the doctor short-token. v1 only carries clinical signature on a
// pre-auth; future scopes (claim sign-off, query response) land here.
export const DoctorTokenScopeSchema = z.enum(['preauth_clinical_sign']);
export type DoctorTokenScope = z.infer<typeof DoctorTokenScopeSchema>;

// POST /preauth/doctor-tokens — insurance desk asks the server to mint a
// doctor link and send it via email/SMS. caseRef is a free-form string
// for v1 (Sprint 2 swaps it for an actual claim_id).
export const IssueDoctorTokenRequestSchema = z.object({
  doctorUserId: z.string().uuid(),
  caseRef: z.string().min(1).max(120),
  patientName: z.string().min(1).max(200),
  scope: DoctorTokenScopeSchema.default('preauth_clinical_sign'),
});
export type IssueDoctorTokenRequest = z.infer<typeof IssueDoctorTokenRequestSchema>;

export const IssueDoctorTokenResponseSchema = z.object({
  tokenId: z.string().uuid(),
  expiresAt: z.string().datetime(),
});
export type IssueDoctorTokenResponse = z.infer<typeof IssueDoctorTokenResponseSchema>;

// GET /preauth/doctor-tokens/:rawToken/preview — public.
export const DoctorTokenPreviewSchema = z.object({
  doctorFirstName: z.string(),
  doctorLastName: z.string(),
  caseRef: z.string(),
  patientName: z.string(),
  scope: DoctorTokenScopeSchema,
  tenantDisplayName: z.string(),
  requesterName: z.string(),
  expiresAt: z.string().datetime(),
});
export type DoctorTokenPreview = z.infer<typeof DoctorTokenPreviewSchema>;

// POST /preauth/doctor-tokens/:rawToken/hpr-init — public. Triggers ABDM
// to send an OTP to the doctor's registered mobile and returns a
// transactionId the client must present on /sign. Step 1 of the
// two-step ABDM auth flow.
export const RequestHprOtpRequestSchema = z.object({
  hprId: z.string().regex(/^[0-9]{14}$/),
});
export type RequestHprOtpRequest = z.infer<typeof RequestHprOtpRequestSchema>;

export const RequestHprOtpResponseSchema = z.object({
  transactionId: z.string(),
  expiresAt: z.string().datetime(),
});
export type RequestHprOtpResponse = z.infer<typeof RequestHprOtpResponseSchema>;

// POST /preauth/doctor-tokens/:rawToken/sign — public. Doctor proves identity
// via HPR id + OTP. transactionId is required when HPR_MODE=real (it
// links the OTP back to the prior /hpr-init call); the stub adapter
// ignores it.
export const SignWithDoctorTokenRequestSchema = z.object({
  hprId: z.string().regex(/^[0-9]{14}$/),
  hprOtp: z.string().regex(/^[0-9]{6}$/),
  hprTransactionId: z.string().min(1).max(200).optional(),
  signatureNote: z.string().max(2000).optional(),
});
export type SignWithDoctorTokenRequest = z.infer<typeof SignWithDoctorTokenRequestSchema>;

export const SignWithDoctorTokenResponseSchema = z.object({
  signedAt: z.string().datetime(),
  doctorFullName: z.string(),
  hprId: z.string(),
});
export type SignWithDoctorTokenResponse = z.infer<typeof SignWithDoctorTokenResponseSchema>;
