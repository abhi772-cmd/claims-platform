import { z } from 'zod';

// All password mutations bottom out in the same min/max length envelope.
// The full strength + breach + history checks happen server-side in
// PasswordPolicyService — this schema is just the wire-shape contract.
const PasswordValueSchema = z.string().min(12).max(256);

// POST /auth/password-reset/initiate — always returns 204 regardless of
// whether the email exists, to avoid leaking account existence.
export const PasswordResetInitiateRequestSchema = z.object({
  email: z.string().email().max(254),
});
export type PasswordResetInitiateRequest = z.infer<typeof PasswordResetInitiateRequestSchema>;

// GET /auth/password-reset/verify?token=... — pre-flight before showing
// the new-password form. 200 if usable, structured error otherwise.
export const PasswordResetVerifyResponseSchema = z.object({
  ok: z.literal(true),
  email: z.string().email(),
  firstName: z.string(),
  expiresAt: z.string().datetime(),
});
export type PasswordResetVerifyResponse = z.infer<typeof PasswordResetVerifyResponseSchema>;

// POST /auth/password-reset/complete
export const PasswordResetCompleteRequestSchema = z.object({
  token: z.string().min(20).max(200),
  password: PasswordValueSchema,
});
export type PasswordResetCompleteRequest = z.infer<typeof PasswordResetCompleteRequestSchema>;

// POST /auth/me/password — authenticated self-change. Requires the current
// password as a precondition (separate from auth) so that hijacked sessions
// can't quietly rotate the password.
export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: PasswordValueSchema,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

// Public policy descriptor — the web app uses these numbers to drive the
// strength meter without hard-coding them in two places.
export const PasswordPolicyDescriptorSchema = z.object({
  minLength: z.number().int().positive(),
  maxLength: z.number().int().positive(),
  requireLower: z.boolean(),
  requireUpper: z.boolean(),
  requireDigit: z.boolean(),
  requireSymbol: z.boolean(),
  historyDepth: z.number().int().nonnegative(),
});
export type PasswordPolicyDescriptor = z.infer<typeof PasswordPolicyDescriptorSchema>;
