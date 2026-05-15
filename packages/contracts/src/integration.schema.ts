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
  // T1-5 — outbound failed transiently and is parked in the replay
  // queue. The NhcxReplayWorker re-issues the call once nextRetryAt
  // has passed. Caller-facing: this is a soft-failure that becomes
  // 'succeeded' (no operator action needed) or 'failed' (retries
  // exhausted) on subsequent worker ticks.
  'queued_for_retry',
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

// Slice BK — PMJAY runs eligibility three times with different purposes:
//   - 'validation'        post-registration wallet / member-active check
//   - 'benefits'          before preauth, to confirm coverage limits
//   - 'auth-requirements' before submission, to fetch the document checklist
// Private rails historically used the combined ['benefits','validation']
// array; we keep that as the implicit default when purpose is omitted so
// existing call sites stay unchanged. PMJAY tenants must specify which
// one — the service rejects a missing purpose at the gate.
export const EligibilityPurposeSchema = z.enum(['validation', 'benefits', 'auth-requirements']);
export type EligibilityPurpose = z.infer<typeof EligibilityPurposeSchema>;

export const EligibilityRequestSchema = z.object({
  // Optional fields that the stub uses to decide verified/failed; real
  // adapter reads the policy + patient details from the case.
  policyNumber: z.string().min(1).max(64).optional(),
  payerCode: z.string().min(1).max(64).optional(),
  purpose: EligibilityPurposeSchema.optional(),
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
  // Slice BC — gateway pushes a PaymentNotice when the payer
  // settles a previously-submitted claim. The payload references
  // the original claim by claimRefNum + correlation, and we
  // dispatch to SettlementService.recordReceipt so the claim
  // auto-flips to PAYMENT_RECEIVED without operator action.
  'paymentnotice/request',
  // Slice BD — remaining HCX 0.7.1 message types. We record them
  // on the integration_message ledger (CLAUDE.md hard-rule #7
  // mandates the audit trail for every external integration) but
  // don't drive state transitions — the operational use cases that
  // would justify auto-actioning these aren't pressing yet.
  //
  //   insuranceplan/on_request — payer-pushed coverage update
  //   task/on_submit            — gateway-pushed task / status note
  'insuranceplan/on_request',
  'task/on_submit',
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
