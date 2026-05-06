import { z } from 'zod';

// IntegrationMessage — every external call (NHCX, PMJAY, ABDM, OpenAI,
// SMTP, TextGuru) writes a row here, both directions. Slice K introduces
// the table + the stub NHCX path; later slices reuse it for the real
// adapters. Listed in CLAUDE.md rule 7.

export const IntegrationDirectionSchema = z.enum(['outbound', 'inbound']);
export type IntegrationDirection = z.infer<typeof IntegrationDirectionSchema>;

export const IntegrationNameSchema = z.enum([
  'nhcx',
  'pmjay_tms',
  'abdm',
  'openai',
  'textguru',
  'smtp',
]);
export type IntegrationName = z.infer<typeof IntegrationNameSchema>;

export const IntegrationStatusSchema = z.enum([
  'pending',
  'sent',
  'succeeded',
  'failed',
  'circuit_open',
]);
export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;

export const IntegrationFailureClassSchema = z.enum([
  'network',
  'auth',
  'validation',
  'server_5xx',
  'captcha',
  'selector',
  'timeout',
  'unknown',
]);
export type IntegrationFailureClass = z.infer<typeof IntegrationFailureClassSchema>;

export const IntegrationMessageSchema = z.object({
  id: z.string().uuid(),
  direction: IntegrationDirectionSchema,
  integration: IntegrationNameSchema,
  operation: z.string(),
  correlationId: z.string(),
  status: IntegrationStatusSchema,
  failureClass: IntegrationFailureClassSchema.nullable(),
  retryCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  // Raw payloads — opaque on the wire. The web app shows them under a
  // "View raw" disclosure for ops debugging; tenants don't normally
  // care about the shape.
  rawRequest: z.unknown().nullable(),
  rawResponse: z.unknown().nullable(),
});
export type IntegrationMessage = z.infer<typeof IntegrationMessageSchema>;

export const IntegrationMessageListResponseSchema = z.object({
  messages: z.array(IntegrationMessageSchema),
});
export type IntegrationMessageListResponse = z.infer<
  typeof IntegrationMessageListResponseSchema
>;

// Eligibility request + response surface. The actual NHCX FHIR Bundle
// shape lives elsewhere (see docs/07); this is the wire shape between
// our web app and our API.
export const EligibilityRequestSchema = z.object({
  // Optional fields that the stub uses to decide verified/failed; real
  // adapter reads the policy + patient details from the case.
  policyNumber: z.string().min(1).max(64).optional(),
  payerCode: z.string().min(1).max(64).optional(),
});
export type EligibilityRequest = z.infer<typeof EligibilityRequestSchema>;

export const EligibilityResponseSchema = z.object({
  verified: z.boolean(),
  planName: z.string().optional(),
  sumInsured: z.number().int().optional(),
  failureReason: z.string().optional(),
  correlationId: z.string(),
  // The new claim status after this cycle ran.
  status: z.string(),
});
export type EligibilityResponse = z.infer<typeof EligibilityResponseSchema>;

// NHCX inbound webhook payload (Slice Z). The HCX gateway POSTs one
// of these for every callback (coverageeligibility/on_check,
// preauth/on_submit, claim/on_submit, communication/request).
//
// The payload is a JWE-wrapped FHIR Bundle that we'll decrypt using
// the recipient private key indicated by the JWE 'kid' header. The
// envelope itself is unauthenticated at the HTTP layer — the real
// authentication is the JWE: only a holder of the matching public
// key could have produced ciphertext that decrypts to a valid Bundle.
//
// Operation discriminates which downstream service handles the
// decrypted bundle. Sender code is logged + cross-checked against
// the payer master to surface unknown-sender callbacks early.
export const NhcxInboundOperationSchema = z.enum([
  'coverageeligibility/on_check',
  'preauth/on_submit',
  'claim/on_submit',
  'communication/request',
]);
export type NhcxInboundOperation = z.infer<typeof NhcxInboundOperationSchema>;

export const NhcxInboundRequestSchema = z.object({
  // Compact JWE (5 dot-separated base64url segments).
  payload: z.string().min(1),
  // Optional — the gateway sets it on most operations. We don't
  // depend on it for decryption (kid in the JWE header is the
  // source of truth) but reject blatantly malformed values.
  type: z.literal('JWEPayload').optional(),
});
export type NhcxInboundRequest = z.infer<typeof NhcxInboundRequestSchema>;

export const NhcxInboundAcceptSchema = z.object({
  status: z.literal('accepted'),
  // Echoed back so the gateway can correlate logs even before the
  // worker finishes processing. Same id we wrote to integration_message.
  correlationId: z.string(),
});
export type NhcxInboundAccept = z.infer<typeof NhcxInboundAcceptSchema>;
