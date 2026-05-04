import { z } from 'zod';

export const LoginRequestSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  user: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    firstName: z.string(),
    lastName: z.string(),
    tenantId: z.string().uuid(),
    mustChangePassword: z.boolean(),
  }),
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const RefreshResponseSchema = z.object({
  ok: z.literal(true),
});
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;

export const MeResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  tenantId: z.string().uuid(),
  tenantSlug: z.string(),
  tenantDisplayName: z.string(),
  roles: z.array(z.string()),
  permissions: z.array(z.string()),
  mustChangePassword: z.boolean(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;
