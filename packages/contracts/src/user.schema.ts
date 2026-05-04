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
