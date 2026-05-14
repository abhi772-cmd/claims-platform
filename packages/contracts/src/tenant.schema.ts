import { z } from 'zod';

export const TenantLifecycleStateSchema = z.enum([
  'CONTRACTED',
  'PROVISIONING',
  'IN_SETUP',
  'PILOT',
  'LIVE',
  'SUSPENDED',
  'CHURNED',
]);
export type TenantLifecycleState = z.infer<typeof TenantLifecycleStateSchema>;

export const TenantSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(1).max(64),
  displayName: z.string().min(1).max(256),
  lifecycleState: TenantLifecycleStateSchema,
});
export type Tenant = z.infer<typeof TenantSchema>;

// Stage-1 onboarding profile (docs/15). Captured by ops on tenant
// provisioning. Stored as nullable columns on `tenant`; the GET
// endpoint returns nulls for fields that haven't been filled in yet.
export const HospitalTypeSchema = z.enum(['private', 'trust', 'government', 'psu']);
export type HospitalType = z.infer<typeof HospitalTypeSchema>;

// Bucket labels: <100, 100-500, 500-2000, 2000+ claims/month. The
// hospital self-declares the band on provisioning; we use it for
// capacity planning and tiering, not for billing.
export const ExpectedMonthlyClaimsBandSchema = z.enum([
  'lt_100',
  'band_100_500',
  'band_500_2000',
  'gt_2000',
]);
export type ExpectedMonthlyClaimsBand = z.infer<typeof ExpectedMonthlyClaimsBandSchema>;

// Format: 9-digit numeric string per the IRDAI ROHINI registry. The
// DB has an equivalent CHECK constraint; we validate here to surface
// a friendly error before the round-trip.
const RohiniIdSchema = z
  .string()
  .regex(/^[0-9]{9}$/, 'ROHINI ID must be a 9-digit number');

export const TenantProfileSchema = z.object({
  legalName: z.string().min(1).max(256).nullable(),
  rohiniId: RohiniIdSchema.nullable(),
  hospitalType: HospitalTypeSchema.nullable(),
  bedCount: z.number().int().positive().max(100_000).nullable(),
  hmisVendor: z.string().min(1).max(128).nullable(),
  expectedMonthlyClaimsBand: ExpectedMonthlyClaimsBandSchema.nullable(),
});
export type TenantProfile = z.infer<typeof TenantProfileSchema>;

// PATCH shape — every field is optional (sparse update). Passing
// `null` explicitly clears a field; omitting it leaves the stored
// value untouched. Strict so unknown keys fail fast in tests.
export const TenantProfileUpdateSchema = z
  .object({
    legalName: z.string().min(1).max(256).nullable().optional(),
    rohiniId: RohiniIdSchema.nullable().optional(),
    hospitalType: HospitalTypeSchema.nullable().optional(),
    bedCount: z.number().int().positive().max(100_000).nullable().optional(),
    hmisVendor: z.string().min(1).max(128).nullable().optional(),
    expectedMonthlyClaimsBand: ExpectedMonthlyClaimsBandSchema.nullable().optional(),
  })
  .strict();
export type TenantProfileUpdate = z.infer<typeof TenantProfileUpdateSchema>;

// Per-tenant comms config — input shape for PATCH /admin/tenant/comms-config.
// Empty object means "use platform env defaults". `null` on a nested key means
// "remove this override and fall back to env" (used for clearing). Secrets
// (smtp.password, sms.apiKey) are write-only; reads return a redacted summary.
export const TenantSmtpConfigSchema = z
  .object({
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    from: z.string().email(),
    username: z.string().min(1).max(256).optional(),
    password: z.string().min(1).max(512).optional(),
    secure: z.boolean().optional(),
    ignoreTls: z.boolean().optional(),
  })
  .strict();
export type TenantSmtpConfig = z.infer<typeof TenantSmtpConfigSchema>;

export const TenantSmsProviderSchema = z.enum(['console', 'textguru']);
export type TenantSmsProvider = z.infer<typeof TenantSmsProviderSchema>;

export const TenantSmsConfigSchema = z
  .object({
    provider: TenantSmsProviderSchema,
    apiKey: z.string().min(1).max(512).optional(),
    senderId: z.string().min(1).max(32).optional(),
  })
  .strict();
export type TenantSmsConfig = z.infer<typeof TenantSmsConfigSchema>;

export const TenantCommsConfigSchema = z
  .object({
    smtp: TenantSmtpConfigSchema.nullable().optional(),
    sms: TenantSmsConfigSchema.nullable().optional(),
  })
  .strict();
export type TenantCommsConfig = z.infer<typeof TenantCommsConfigSchema>;

// Read shape returned to admins. Secrets are replaced with a boolean flag
// indicating whether a value is set, never the value itself.
export const TenantCommsConfigSummarySchema = z
  .object({
    smtp: z
      .object({
        host: z.string(),
        port: z.number().int(),
        from: z.string(),
        username: z.string().nullable(),
        passwordSet: z.boolean(),
        secure: z.boolean().nullable(),
        ignoreTls: z.boolean().nullable(),
        source: z.enum(['tenant', 'env']),
      })
      .nullable(),
    sms: z
      .object({
        provider: TenantSmsProviderSchema,
        senderId: z.string().nullable(),
        apiKeySet: z.boolean(),
        source: z.enum(['tenant', 'env']),
      })
      .nullable(),
  })
  .strict();
export type TenantCommsConfigSummary = z.infer<typeof TenantCommsConfigSummarySchema>;
