import { z } from 'zod';

import { RoleNameSchema } from './user.schema';

// POST /tenant/users — admin invites a new user.
export const InviteUserRequestSchema = z.object({
  email: z.string().email().max(254),
  firstName: z.string().min(1).max(120),
  lastName: z.string().min(1).max(120),
  mobile: z.string().regex(/^\+?[0-9]{8,15}$/).optional(),
  designation: z.string().min(1).max(120).optional(),
  roles: z.array(RoleNameSchema).min(1).max(8),
});
export type InviteUserRequest = z.infer<typeof InviteUserRequestSchema>;

export const InviteUserResponseSchema = z.object({
  user: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    firstName: z.string(),
    lastName: z.string(),
    status: z.literal('invited'),
    inviteExpiresAt: z.string().datetime(),
  }),
});
export type InviteUserResponse = z.infer<typeof InviteUserResponseSchema>;

// GET /auth/invite/:token — preview before accepting (unauthenticated).
export const InvitePreviewSchema = z.object({
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  tenantDisplayName: z.string(),
  roles: z.array(z.string()),
  expiresAt: z.string().datetime(),
});
export type InvitePreview = z.infer<typeof InvitePreviewSchema>;

// POST /auth/accept-invite
export const AcceptInviteRequestSchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(12).max(256),
});
export type AcceptInviteRequest = z.infer<typeof AcceptInviteRequestSchema>;
