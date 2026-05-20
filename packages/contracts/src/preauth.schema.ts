import { z } from 'zod';

// PreauthDraft is the editable form a user fills in before clicking
// "Submit pre-auth". One row per Claim — updates are upserts. Sprint 2's
// stub flow doesn't enforce field-level required-when-submitting; the
// service-side validateAll path catches missing fields before transition.
export const PreauthDraftSchema = z.object({
  diagnosisIcdCode: z.string().min(1).max(32).optional(),
  diagnosisDescription: z.string().min(1).max(500).optional(),
  plannedProcedure: z.string().min(1).max(500).optional(),
  procedureCode: z.string().min(1).max(32).optional(),
  // D-023 — HBP package code. When set, the save path snapshots the
  // package as the PRIMARY claim line and auto-fills requestedAmount
  // from its fixed rate (unless requestedAmount was sent explicitly —
  // the operator can still override for enhancement / implant cases).
  packageCode: z.string().min(1).max(64).optional(),
  estimatedLengthOfStayDays: z.number().int().nonnegative().max(365).optional(),
  requestedAmount: z.number().int().nonnegative().optional(),
  clinicalJustification: z.string().min(1).max(5000).optional(),
});
export type PreauthDraft = z.infer<typeof PreauthDraftSchema>;

// PUT /cases/:c/claims/:cl/preauth/draft — upsert.
export const PreauthDraftRequestSchema = PreauthDraftSchema;
export type PreauthDraftRequest = z.infer<typeof PreauthDraftRequestSchema>;

export const PreauthDraftResponseSchema = z.object({
  draft: PreauthDraftSchema,
  status: z.string(),
  updatedAt: z.string().datetime(),
});
export type PreauthDraftResponse = z.infer<typeof PreauthDraftResponseSchema>;

// POST /cases/:c/claims/:cl/preauth/submit — body is empty for the stub.
// The real adapter uses the saved draft; the stub also reads from it
// because we exercise the same validation path.
export const PreauthSubmitRequestSchema = z.object({});
export type PreauthSubmitRequest = z.infer<typeof PreauthSubmitRequestSchema>;

export const PreauthSubmitResponseSchema = z.object({
  status: z.string(),
  payerRefNum: z.string().nullable(),
  correlationId: z.string(),
});
export type PreauthSubmitResponse = z.infer<typeof PreauthSubmitResponseSchema>;

// POST /cases/:c/claims/:cl/preauth/queries/:qid/respond
export const PreauthQueryResponseRequestSchema = z.object({
  responseText: z.string().min(1).max(5000),
});
export type PreauthQueryResponseRequest = z.infer<typeof PreauthQueryResponseRequestSchema>;

// POST /cases/:c/claims/:cl/preauth/decision — admin escape hatch
// for ops + tests. The real production decision arrives via the rail
// adapter callback once Slice P ships.
export const PreauthDecisionKindSchema = z.enum([
  'approved',
  'rejected',
  'partially_approved',
  'query_received',
]);
export type PreauthDecisionKind = z.infer<typeof PreauthDecisionKindSchema>;

export const PreauthDecisionRequestSchema = z.object({
  kind: PreauthDecisionKindSchema,
  approvedAmount: z.number().int().nonnegative().optional(),
  reason: z.string().max(2000).optional(),
  queryText: z.string().max(5000).optional(),
});
export type PreauthDecisionRequest = z.infer<typeof PreauthDecisionRequestSchema>;

export const PreauthDecisionResponseSchema = z.object({
  status: z.string(),
  approvedAmount: z.number().int().nullable(),
});
export type PreauthDecisionResponse = z.infer<typeof PreauthDecisionResponseSchema>;

// Slice BH — POST /cases/:c/claims/:cl/preauth/cancel — operator-driven
// cancel via outbound NHCX `task/submit` with PMJAY's `code: 'cancel'`
// shape. PMJAY-only in v1; the controller asserts the calling
// tenant's pmjayMode === 'on' before reaching the service.
export const PreauthCancelRequestSchema = z.object({
  // Optional free-text reason logged on the FHIR Task.note for the
  // payer's audit trail. 2000 char ceiling matches PreauthDecision's
  // reason field for consistency.
  reason: z.string().max(2000).optional(),
});
export type PreauthCancelRequest = z.infer<typeof PreauthCancelRequestSchema>;

export const PreauthCancelResponseSchema = z.object({
  status: z.string(),
  correlationId: z.string(),
});
export type PreauthCancelResponse = z.infer<typeof PreauthCancelResponseSchema>;

// Slice BL — PMJAY tenants don't respond to queries via Communication;
// they pull the preauth back to PREAUTH_DRAFTING and re-submit. This
// is a state-only flip (no NHCX call); the next preauth submit is
// what reaches the gateway. PMJAY-only.
export const PreauthResubmitRequestSchema = z.object({
  // Optional free-text note from the operator. Stamped on every
  // outstanding preauth_query row's responseText (prefixed
  // [resubmit] ...) so the audit trail captures *why* the operator
  // pulled back to drafting instead of responding.
  reason: z.string().max(2000).optional(),
});
export type PreauthResubmitRequest = z.infer<typeof PreauthResubmitRequestSchema>;

export const PreauthResubmitResponseSchema = z.object({
  status: z.string(),
});
export type PreauthResubmitResponse = z.infer<typeof PreauthResubmitResponseSchema>;
