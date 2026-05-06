import { z } from 'zod';

// Slice AH — appeal lifecycle contracts.

export const AppealStatusSchema = z.enum(['initiated', 'submitted', 'resolved']);
export type AppealStatus = z.infer<typeof AppealStatusSchema>;

export const AppealResolutionKindSchema = z.enum([
  'approved',
  'partially_approved',
  'rejected',
]);
export type AppealResolutionKind = z.infer<typeof AppealResolutionKindSchema>;

// POST /cases/:c/claims/:cl/appeal/start — required: reason. The
// claim must be at PREAUTH_REJECTED, CLAIM_REJECTED, or SHORT_PAID
// for the appeal.started event to be allowed. State-machine
// rejection surfaces as VALIDATION_FAILED.
export const StartAppealRequestSchema = z.object({
  reason: z.string().min(1).max(2000),
});
export type StartAppealRequest = z.infer<typeof StartAppealRequestSchema>;

// POST /cases/:c/claims/:cl/appeal/submit — operator finalises the
// appeal package + (in a Sprint 5 slice) sends to the payer. Today
// the "send" is a stub. supportingDocuments[] is a list of Document
// ids already uploaded under the claim.
export const SubmitAppealRequestSchema = z.object({
  supportingDocumentIds: z.array(z.string().uuid()).default([]),
});
export type SubmitAppealRequest = z.infer<typeof SubmitAppealRequestSchema>;

// POST /cases/:c/claims/:cl/appeal/resolve — operator records the
// payer's decision. approved + partially_approved require
// approvedAmount; rejected requires nothing more than the
// resolutionNote.
export const ResolveAppealRequestSchema = z
  .object({
    kind: AppealResolutionKindSchema,
    approvedAmount: z.number().int().nonnegative().optional(),
    note: z.string().max(2000).optional(),
  })
  .refine(
    (data) =>
      data.kind === 'rejected' ||
      (data.approvedAmount !== undefined && data.approvedAmount > 0),
    {
      message: 'approvedAmount is required and must be positive for approved / partially_approved.',
      path: ['approvedAmount'],
    },
  );
export type ResolveAppealRequest = z.infer<typeof ResolveAppealRequestSchema>;

export const AppealSummarySchema = z.object({
  id: z.string().uuid(),
  claimId: z.string().uuid(),
  status: AppealStatusSchema,
  reason: z.string(),
  supportingDocumentIds: z.array(z.string().uuid()),
  resolutionKind: AppealResolutionKindSchema.nullable(),
  resolutionNote: z.string().nullable(),
  approvedAmount: z.number().int().nullable(),
  startedAt: z.string(),
  submittedAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
});
export type AppealSummary = z.infer<typeof AppealSummarySchema>;

export const AppealResponseSchema = z.object({
  appeal: AppealSummarySchema,
  // The claim status after this operation.
  claimStatus: z.string(),
});
export type AppealResponse = z.infer<typeof AppealResponseSchema>;
