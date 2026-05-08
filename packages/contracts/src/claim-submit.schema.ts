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

// Slice BI — POST /cases/:c/claims/:cl/claim-submission/reprocess —
// PMJAY CRC (Claim Re-Consideration) request. Two reason codes
// per the PMJAY supporting docs:
//   - 'claimrejected'  — re-evaluate a CLAIM_REJECTED case
//   - 'partialpayment' — re-evaluate a SHORT_PAID case
// Both flow through the same outbound `task/submit` operation;
// the payer routes by reasonCode. PMJAY-only — service guards on
// tenant.pmjayMode === 'on'.
export const ReprocessReasonCodeSchema = z.enum(['claimrejected', 'partialpayment']);
export type ReprocessReasonCode = z.infer<typeof ReprocessReasonCodeSchema>;

export const ClaimReprocessRequestSchema = z.object({
  reasonCode: ReprocessReasonCodeSchema,
  reason: z.string().max(2000).optional(),
});
export type ClaimReprocessRequest = z.infer<typeof ClaimReprocessRequestSchema>;

export const ClaimReprocessResponseSchema = z.object({
  status: z.string(),
  correlationId: z.string(),
});
export type ClaimReprocessResponse = z.infer<typeof ClaimReprocessResponseSchema>;

// Slice BL — PMJAY claim re-submit on query. Mirror of the preauth
// resubmit flow: state-only flip from CLAIM_QUERY_RAISED back to
// CLAIM_DRAFTING; the next /claim-submission/submit is what reaches
// the gateway. PMJAY-only.
export const ClaimResubmitRequestSchema = z.object({
  reason: z.string().max(2000).optional(),
});
export type ClaimResubmitRequest = z.infer<typeof ClaimResubmitRequestSchema>;

export const ClaimResubmitResponseSchema = z.object({
  status: z.string(),
});
export type ClaimResubmitResponse = z.infer<typeof ClaimResubmitResponseSchema>;
