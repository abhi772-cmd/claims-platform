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

// POST /preauth/doctor-tokens/:rawToken/sign — public. Doctor proves identity
// via HPR id + OTP (the OTP comes from the ABDM-issued auth flow; v1's stub
// accepts a fixed OTP per env config so we can demo end to end without a
// live ABDM connection).
export const SignWithDoctorTokenRequestSchema = z.object({
  hprId: z.string().regex(/^[0-9]{14}$/),
  hprOtp: z.string().regex(/^[0-9]{6}$/),
  signatureNote: z.string().max(2000).optional(),
});
export type SignWithDoctorTokenRequest = z.infer<typeof SignWithDoctorTokenRequestSchema>;

export const SignWithDoctorTokenResponseSchema = z.object({
  signedAt: z.string().datetime(),
  doctorFullName: z.string(),
  hprId: z.string(),
});
export type SignWithDoctorTokenResponse = z.infer<typeof SignWithDoctorTokenResponseSchema>;
