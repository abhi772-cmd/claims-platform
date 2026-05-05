import { z } from 'zod';

// Wire shapes for the MFA flow. Storage shapes (BackupCode rows, MfaEnrollment
// rows, etc.) live in the API and are NOT exported here — the contract is
// only what crosses the network boundary.

// 6-digit TOTP code or 10-char backup code.
const TotpCodeSchema = z.string().regex(/^[0-9]{6}$/);
const BackupCodeSchema = z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

// POST /auth/me/mfa/setup — start enrollment. Returns the secret + otpauth
// URL so the web app can render a QR. The user is NOT yet enrolled until
// they confirm with a valid TOTP code.
export const MfaSetupResponseSchema = z.object({
  secret: z.string(),
  otpauthUrl: z.string().url(),
  qrDataUrl: z.string(), // image/png;base64,...
});
export type MfaSetupResponse = z.infer<typeof MfaSetupResponseSchema>;

// POST /auth/me/mfa/confirm — finish enrollment. Body carries one TOTP code
// derived from the pending secret; on success returns the one-time list of
// backup codes so the user can save them.
export const MfaConfirmRequestSchema = z.object({
  code: TotpCodeSchema,
});
export type MfaConfirmRequest = z.infer<typeof MfaConfirmRequestSchema>;

export const MfaConfirmResponseSchema = z.object({
  backupCodes: z.array(BackupCodeSchema).length(10),
});
export type MfaConfirmResponse = z.infer<typeof MfaConfirmResponseSchema>;

// POST /auth/me/mfa/disable — turns off MFA. Requires currentPassword + a
// fresh TOTP/backup code to prove ownership of both factors.
export const MfaDisableRequestSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  code: z.union([TotpCodeSchema, BackupCodeSchema]),
});
export type MfaDisableRequest = z.infer<typeof MfaDisableRequestSchema>;

// POST /auth/me/mfa/backup-codes/regenerate — invalidates the existing list
// and returns 10 new ones. Same precondition as disable.
export const MfaRegenerateBackupCodesRequestSchema = z.object({
  currentPassword: z.string().min(1).max(256),
});
export type MfaRegenerateBackupCodesRequest = z.infer<
  typeof MfaRegenerateBackupCodesRequestSchema
>;

export const MfaRegenerateBackupCodesResponseSchema = z.object({
  backupCodes: z.array(BackupCodeSchema).length(10),
});
export type MfaRegenerateBackupCodesResponse = z.infer<
  typeof MfaRegenerateBackupCodesResponseSchema
>;

// Login response when the user has MFA enabled — instead of issuing the full
// access cookie, the API returns a short-lived challengeId. The client then
// posts that challengeId + the user's TOTP/backup code to /auth/mfa/verify
// to complete login.
export const LoginMfaChallengeResponseSchema = z.object({
  mfaRequired: z.literal(true),
  challengeId: z.string(),
  expiresAt: z.string().datetime(),
});
export type LoginMfaChallengeResponse = z.infer<typeof LoginMfaChallengeResponseSchema>;

export const MfaVerifyRequestSchema = z.object({
  challengeId: z.string().min(20).max(200),
  code: z.union([TotpCodeSchema, BackupCodeSchema]),
});
export type MfaVerifyRequest = z.infer<typeof MfaVerifyRequestSchema>;
