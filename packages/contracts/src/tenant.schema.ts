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
