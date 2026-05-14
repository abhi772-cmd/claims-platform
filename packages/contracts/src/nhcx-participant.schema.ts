import { z } from 'zod';

// Slice ON-4 of the onboarding spec diff (docs/15) — NHCX participant
// onboarding contract. The flow:
//   1. Ops opens /admin/nhcx-participants, picks the tenant
//   2. Ops fills HFR ID + callback URL + sandbox/prod choice
//   3. POST /admin/tenants/:id/nhcx/register-participant
//   4. Server calls NHA's participant API (stub-mode synthesises a
//      participant code; real-mode wraps NHA's documented endpoint)
//   5. Server writes a `tenant_nhcx_config` row + an integration_message
//      pair + auto-completes hfr_facility / nhcx_participant_code /
//      nhcx_callback_url onboarding steps
//
// The participant code (`<id>@hcx`) is the unforgeable identity NHA
// stamps on every outbound message — without it the tenant cannot
// transact on the network.

export const NhcxParticipantRoleSchema = z.enum(['provider', 'payer']);
export type NhcxParticipantRole = z.infer<typeof NhcxParticipantRoleSchema>;

// HFR facility IDs are issued by facility.abdm.gov.in. NHA's docs
// describe a 9-13 character alphanumeric token; we validate length
// only, leaving the content opaque so format changes upstream don't
// break us.
const HfrFacilityIdSchema = z
  .string()
  .min(6)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, 'HFR facility ID may only contain letters, digits, ".", "_", "-".');

// The bridge URL we register with NHA. NHA's gateway POSTs every
// async response here, so it must be reachable from NHA's network.
const CallbackUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((u) => u.startsWith('https://'), {
    message: 'Callback URL must use https.',
  });

// POST /admin/tenants/:tenantId/nhcx/register-participant
export const RegisterNhcxParticipantRequestSchema = z
  .object({
    hfrFacilityId: HfrFacilityIdSchema,
    callbackUrl: CallbackUrlSchema,
    role: NhcxParticipantRoleSchema.optional(), // defaults to 'provider'
    sandboxMode: z.boolean().optional(), // defaults to true
  })
  .strict();
export type RegisterNhcxParticipantRequest = z.infer<
  typeof RegisterNhcxParticipantRequestSchema
>;

// Read shape returned by GET /admin/tenants/:tenantId/nhcx/participant-status
// and embedded into the cross-tenant listing.
export const NhcxParticipantConfigSchema = z.object({
  hfrFacilityId: z.string(),
  participantCode: z.string().nullable(),
  role: NhcxParticipantRoleSchema,
  callbackUrl: z.string(),
  sandboxMode: z.boolean(),
  registeredAt: z.string().datetime().nullable(),
  registeredByUserId: z.string().uuid().nullable(),
  lastError: z.string().nullable(),
});
export type NhcxParticipantConfig = z.infer<typeof NhcxParticipantConfigSchema>;

export const NhcxParticipantStatusResponseSchema = z.object({
  // Null when no registration attempt has been made.
  config: NhcxParticipantConfigSchema.nullable(),
});
export type NhcxParticipantStatusResponse = z.infer<
  typeof NhcxParticipantStatusResponseSchema
>;

// GET /admin/nhcx-participants — cross-tenant listing for the ops
// dashboard. Includes the tenant display fields so ops doesn't need
// a second round-trip per row.
export const NhcxParticipantListItemSchema = z.object({
  tenantId: z.string().uuid(),
  tenantSlug: z.string(),
  tenantDisplayName: z.string(),
  config: NhcxParticipantConfigSchema.nullable(),
});
export type NhcxParticipantListItem = z.infer<typeof NhcxParticipantListItemSchema>;

export const NhcxParticipantListResponseSchema = z.object({
  items: z.array(NhcxParticipantListItemSchema),
});
export type NhcxParticipantListResponse = z.infer<
  typeof NhcxParticipantListResponseSchema
>;
