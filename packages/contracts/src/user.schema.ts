import { z } from 'zod';

export const UserStatusSchema = z.enum(['invited', 'active', 'suspended', 'deactivated']);
export type UserStatus = z.infer<typeof UserStatusSchema>;

export const PermissionSchema = z.string().regex(/^[a-z_]+\.[a-z_]+(\.[a-z_]+)?$/);
export type Permission = z.infer<typeof PermissionSchema>;

export const RoleNameSchema = z.enum([
  'platform_admin',
  'tenant_admin',
  'billing_manager',
  'insurance_desk_executive',
  'pmam',
  'doctor',
  'finance_viewer',
  'read_only',
]);
export type RoleName = z.infer<typeof RoleNameSchema>;

export const RoleSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid().nullable(),
  name: RoleNameSchema,
  permissions: z.array(PermissionSchema),
});
export type Role = z.infer<typeof RoleSchema>;

export const UserSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  status: UserStatusSchema,
  mfaEnabled: z.boolean(),
  mustChangePassword: z.boolean(),
});
export type User = z.infer<typeof UserSchema>;

// Admin /tenant/users directory view. Carries the lightweight
// per-row data the admin/users page needs — identity, status,
// roles, last-login. mfaEnabled is surfaced because it's a
// security-posture signal admins want to scan at a glance.
//
// inviteExpiresAt is non-null only for users in 'invited' state;
// the admin/users page renders a "expires in X days" hint and an
// inline "Resend invite" affordance on these rows.
export const TenantUserSummarySchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  designation: z.string().nullable(),
  status: UserStatusSchema,
  roles: z.array(RoleNameSchema),
  mfaEnabled: z.boolean(),
  lastLoginAt: z.string().datetime().nullable(),
  inviteExpiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type TenantUserSummary = z.infer<typeof TenantUserSummarySchema>;

export const ListTenantUsersResponseSchema = z.object({
  users: z.array(TenantUserSummarySchema),
});
export type ListTenantUsersResponse = z.infer<typeof ListTenantUsersResponseSchema>;
