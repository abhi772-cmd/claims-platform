import { z } from 'zod';

// Discharge — empty bodies for V1 (state alone drives the transitions).
// Sprint 3 may add a reason / discharge-type field to the submit payload
// once the UI matures.
export const DischargeInitiateRequestSchema = z.object({});
export type DischargeInitiateRequest = z.infer<typeof DischargeInitiateRequestSchema>;

export const DischargeSubmitRequestSchema = z.object({});
export type DischargeSubmitRequest = z.infer<typeof DischargeSubmitRequestSchema>;

export const DischargeResponseSchema = z.object({
  status: z.string(),
});
export type DischargeResponse = z.infer<typeof DischargeResponseSchema>;

// Claim submission — finalAmount is the only mandatory body field.
// requestedAmount on the pre-auth was the *estimate*; finalAmount is
// what the hospital is asking the payer to settle for.
export const ClaimSubmissionStartRequestSchema = z.object({});
export type ClaimSubmissionStartRequest = z.infer<typeof ClaimSubmissionStartRequestSchema>;

export const ClaimSubmissionSubmitRequestSchema = z.object({
  finalAmount: z.number().int().positive(),
});
export type ClaimSubmissionSubmitRequest = z.infer<typeof ClaimSubmissionSubmitRequestSchema>;

export const ClaimSubmissionResponseSchema = z.object({
  status: z.string(),
  claimRefNum: z.string().nullable(),
  correlationId: z.string().nullable(),
});
export type ClaimSubmissionResponse = z.infer<typeof ClaimSubmissionResponseSchema>;

// Claim decision — admin escape hatch for the claim phase. Same shape
// pattern as PreauthDecisionRequest.
export const ClaimDecisionKindSchema = z.enum([
  'approved',
  'rejected',
  'partially_approved',
  'query_received',
]);
export type ClaimDecisionKind = z.infer<typeof ClaimDecisionKindSchema>;

export const ClaimDecisionRequestSchema = z.object({
  kind: ClaimDecisionKindSchema,
  approvedAmount: z.number().int().nonnegative().optional(),
  reason: z.string().max(2000).optional(),
  queryText: z.string().max(5000).optional(),
});
export type ClaimDecisionRequest = z.infer<typeof ClaimDecisionRequestSchema>;

export const ClaimDecisionResponseSchema = z.object({
  status: z.string(),
  approvedAmount: z.number().int().nullable(),
});
export type ClaimDecisionResponse = z.infer<typeof ClaimDecisionResponseSchema>;
