import { z } from 'zod';

// CIDR or single-IP string. We accept both IPv4 (1.2.3.4 or 1.2.3.0/24)
// and IPv6 (::1 or 2001:db8::/32). Validation is a coarse-grained regex
// here; the server re-parses with Node's net + cidr libs and 422s on
// anything that fails strict parse.
const CidrOrIpSchema = z.string().min(1).max(64);

// GET / PUT /tenant/security/ip-allowlist
export const IpAllowlistSchema = z.object({
  cidrs: z.array(CidrOrIpSchema).max(100),
});
export type IpAllowlist = z.infer<typeof IpAllowlistSchema>;

// GET /auth/me/sessions
export const SessionListItemSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  isCurrent: z.boolean(),
});
export type SessionListItem = z.infer<typeof SessionListItemSchema>;

export const SessionListResponseSchema = z.object({
  sessions: z.array(SessionListItemSchema),
});
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;

// GET /auth/me/trusted-devices
export const TrustedDeviceListItemSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  isCurrent: z.boolean(),
});
export type TrustedDeviceListItem = z.infer<typeof TrustedDeviceListItemSchema>;

export const TrustedDeviceListResponseSchema = z.object({
  devices: z.array(TrustedDeviceListItemSchema),
});
export type TrustedDeviceListResponse = z.infer<typeof TrustedDeviceListResponseSchema>;

// MFA verify request gains an optional trustDevice flag — when true the
// server issues a trusted-device cookie alongside the access cookies.
// We export an extended shape here; the API uses the canonical schema
// from mfa.schema.ts and this is just the optional add-on.
export const MfaVerifyTrustFlagSchema = z.object({
  trustDevice: z.boolean().optional(),
});
export type MfaVerifyTrustFlag = z.infer<typeof MfaVerifyTrustFlagSchema>;
