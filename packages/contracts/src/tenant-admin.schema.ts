import { z } from 'zod';

import { AuditLogEntrySchema } from './audit.schema';
import { OnboardingStepSchema } from './onboarding.schema';
import { TenantLifecycleStateSchema } from './tenant.schema';

// Platform-admin tenant onboarding. DigiSparsh ops creates the
// hospital record + invites the primary admin in one round-trip;
// downstream onboarding (KYC, NHCX participant registration, etc.)
// runs through the existing wizard once the primary admin signs in.

// Slug rules: lowercase letters, digits, dashes. Must be 3–48 chars.
// The slug shows up in URLs, audit logs, and (in future) a per-tenant
// subdomain — keep it terse and URL-safe.
export const TenantSlugSchema = z
  .string()
  .min(3)
  .max(48)
  .regex(/^[a-z][a-z0-9-]*[a-z0-9]$/, {
    message:
      'Slug must be 3-48 chars, start with a letter, contain only lowercase letters, digits, and dashes.',
  });

export const PrimaryAdminInputSchema = z
  .object({
    email: z.string().email().max(254),
    firstName: z.string().min(1).max(128),
    lastName: z.string().min(1).max(128),
    // E.164-ish; we don't require + because TextGuru in dev accepts
    // either. Storage normalises in the notification adapter.
    mobile: z.string().min(7).max(20).optional(),
    designation: z.string().min(1).max(128).optional(),
  })
  .strict();
export type PrimaryAdminInput = z.infer<typeof PrimaryAdminInputSchema>;

export const CreateTenantRequestSchema = z
  .object({
    slug: TenantSlugSchema,
    displayName: z.string().min(1).max(256),
    primaryAdmin: PrimaryAdminInputSchema,
  })
  .strict();
export type CreateTenantRequest = z.infer<typeof CreateTenantRequestSchema>;

export const CreateTenantResponseSchema = z.object({
  tenant: z.object({
    id: z.string().uuid(),
    slug: z.string(),
    displayName: z.string(),
    lifecycleState: TenantLifecycleStateSchema,
  }),
  primaryAdmin: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    inviteExpiresAt: z.string().datetime(),
  }),
});
export type CreateTenantResponse = z.infer<typeof CreateTenantResponseSchema>;

// Primary admin status surfaced in the hospital listing. The "primary
// admin" is the first user assigned the tenant_admin role for this
// tenant — almost always the user invited at tenant creation time. We
// surface it so ops can see at a glance whether the hospital has
// activated yet, or whether the invite is going to expire.
export const TenantPrimaryAdminSummarySchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  // 'invited' = pending acceptance; 'active' = accepted; other states
  // (suspended, deactivated) bubble through as-is from the user row.
  status: z.string(),
  // Present when status === 'invited' AND the invite hasn't been used.
  // Null otherwise; ISO datetime when present.
  inviteExpiresAt: z.string().datetime().nullable(),
  // Whether the invite is past its TTL right now. UI surfaces an
  // expired-invite tag and the Resend button stays available so ops
  // can re-issue a fresh token.
  inviteExpired: z.boolean(),
});
export type TenantPrimaryAdminSummary = z.infer<typeof TenantPrimaryAdminSummarySchema>;

// GET /admin/tenants — listing for the platform-ops dashboard.
export const TenantAdminListItemSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  displayName: z.string(),
  lifecycleState: TenantLifecycleStateSchema,
  createdAt: z.string().datetime(),
  // Quick-glance signal so ops sees who's still in setup vs. live.
  // Tenant counts of currently-active users; nullable until tenant has
  // at least one accepted invite.
  activeUserCount: z.number().int().nonnegative(),
  // Null when the tenant has no tenant_admin user yet (created via the
  // legacy DB-seed path, not the /admin/tenants flow).
  primaryAdmin: TenantPrimaryAdminSummarySchema.nullable(),
});
export type TenantAdminListItem = z.infer<typeof TenantAdminListItemSchema>;

// POST /admin/tenants/:tenantId/users/:userId/resend-invite
// Response carries the fresh expiry the caller can surface in the UI
// without an immediate refetch.
export const ResendPrimaryInviteResponseSchema = z.object({
  inviteExpiresAt: z.string().datetime(),
});
export type ResendPrimaryInviteResponse = z.infer<
  typeof ResendPrimaryInviteResponseSchema
>;

// GET /admin/tenants/:tenantId — ops drill-down. Aggregates everything
// ops typically wants without forcing them to log in as the tenant
// admin: tenant + primary admin + every onboarding step + the last
// ~20 audit rows for this tenant. All read-only — mutating actions
// stay on their dedicated endpoints (resend invite, lifecycle, etc.).
export const TenantAdminDetailResponseSchema = z.object({
  tenant: z.object({
    id: z.string().uuid(),
    slug: z.string(),
    displayName: z.string(),
    lifecycleState: TenantLifecycleStateSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
  primaryAdmin: TenantPrimaryAdminSummarySchema.nullable(),
  activeUserCount: z.number().int().nonnegative(),
  invitedUserCount: z.number().int().nonnegative(),
  onboardingSteps: z.array(OnboardingStepSchema),
  recentActivity: z.array(AuditLogEntrySchema),
});
export type TenantAdminDetailResponse = z.infer<
  typeof TenantAdminDetailResponseSchema
>;

export const TenantAdminListResponseSchema = z.object({
  items: z.array(TenantAdminListItemSchema),
});
export type TenantAdminListResponse = z.infer<typeof TenantAdminListResponseSchema>;
