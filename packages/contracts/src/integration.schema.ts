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
