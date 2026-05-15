import { z } from 'zod';

import { ClaimSlaSchema } from './sla.schema';

// All 35 statuses from docs/04-state-machines.md. The order matters for
// no client — keep it in lockstep with the doc's section order so the
// diff stays grep-able.
export const ClaimStatusSchema = z.enum([
  'INITIATED',
  'ELIGIBILITY_CHECK_PENDING',
  'ELIGIBILITY_VERIFIED',
  'ELIGIBILITY_FAILED',

  'PREAUTH_DRAFTING',
  'PREAUTH_QUEUED',
  'PREAUTH_SUBMITTED',
  'PREAUTH_QUERY_RAISED',
  'PREAUTH_QUERY_RESPONDED',
  'PREAUTH_APPROVED',
  'PREAUTH_REJECTED',
  'PREAUTH_PARTIALLY_APPROVED',
  // Slice BH — operator-driven cancellation of an already-submitted
  // preauth. PMJAY tenants drive this via the `task/submit` outbound
  // with `code: 'cancel'`; non-PMJAY tenants currently can't reach
  // this status (the cancel endpoint is gated on tenant.pmjayMode).
  'PREAUTH_CANCELLED',

  'ENHANCEMENT_DRAFTING',
  'ENHANCEMENT_QUEUED',
  'ENHANCEMENT_SUBMITTED',
  'ENHANCEMENT_APPROVED',
  'ENHANCEMENT_REJECTED',

  'DISCHARGE_PENDING',
  'DISCHARGE_SUBMITTED',

  'CLAIM_DRAFTING',
  'CLAIM_QUEUED',
  'CLAIM_SUBMITTED',
  'CLAIM_QUERY_RAISED',
  'CLAIM_QUERY_RESPONDED',
  'CLAIM_APPROVED',
  'CLAIM_REJECTED',
  'CLAIM_PARTIALLY_APPROVED',
  // Slice BI — operator-driven CRC (Claim Re-Consideration) request
  // via PMJAY task/submit. Reachable from CLAIM_REJECTED
  // (reasonCode='claimrejected') and SHORT_PAID
  // (reasonCode='partialpayment'). Existing decision events
  // (claim.approved / .rejected / .partially_approved) re-decide
  // from this state via the inbound dispatcher.
  'CLAIM_REPROCESS_REQUESTED',

  'PAYMENT_PENDING',
  'PAYMENT_RECEIVED',
  'PAYMENT_RECONCILED',
  'SHORT_PAID',
  'WRITTEN_OFF',

  'APPEAL_INITIATED',
  'APPEAL_SUBMITTED',
  'APPEAL_RESOLVED',

  'CLOSED',
  'ABANDONED',
]);
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;

// Two rails the platform supports. Maps to the rail column on Claim;
// also informs which integration adapter (NHCX vs PMJAY) to call at
// each transition.
export const ClaimRailSchema = z.enum(['nhcx', 'pmjay', 'self_pay']);
export type ClaimRail = z.infer<typeof ClaimRailSchema>;

// Claim event types — verbs that drive transitions. Names from
// docs/04-state-machines.md. Keep in sync with the transition table
// inside the API.
export const ClaimEventTypeSchema = z.enum([
  // creation
  'case.created',

  // eligibility
  'eligibility.requested',
  'eligibility.verified',
  'eligibility.failed',
  'eligibility.retry',

  // preauth
  'preauth.drafting_started',
  'preauth.submitted_internally',
  'preauth.acknowledged_by_payer',
  'preauth.submission_failed',
  'preauth.query_received',
  'preauth.query_responded',
  'preauth.approved',
  'preauth.rejected',
  'preauth.partially_approved',
  // Slice BH — operator-driven cancellation post-submit (PMJAY
  // task/submit outbound).
  'preauth.cancelled',
  // Slice BL — PMJAY tenants don't use Communication-based query
  // responses; instead, an operator pulls the preauth back to
  // PREAUTH_DRAFTING, edits, and re-submits. The query record
  // stays in place for audit.
  'preauth.resubmission_started',

  // enhancement
  'enhancement.drafting_started',
  'enhancement.submitted_internally',
  'enhancement.acknowledged',
  'enhancement.approved',
  'enhancement.rejected',

  // discharge / claim
  'discharge.initiated',
  'discharge.submitted',
  'claim.drafting_started',
  'claim.submitted_internally',
  'claim.acknowledged',
  'claim.query_received',
  'claim.query_responded',
  'claim.approved',
  'claim.rejected',
  'claim.partially_approved',
  // Slice BI — operator-driven CRC reprocess via PMJAY task/submit.
  'claim.reprocess_requested',
  // Slice BL — PMJAY tenants re-submit instead of responding via
  // Communication. Pulls the claim back to CLAIM_DRAFTING for edit.
  'claim.resubmission_started',

  // payment / settlement
  'payment.expected',
  'payment.received',
  'payment.reconciled',
  'payment.short_paid',
  'claim.written_off',
  'claim.closed',

  // appeal
  'appeal.started',
  'appeal.submitted',
  'appeal.resolved',

  // case-level
  'case.abandoned',

  // Stage 5 — hospital-initiated communication/request.
  // These are NON-TRANSITIONING events: the claim status stays
  // exactly where it is (resultingStatus = currentStatus). They
  // populate the case-detail communications timeline without
  // touching the state machine. The corresponding gateway traffic
  // is logged in integration_message as usual.
  'communication.outbound_sent',
  'communication.inbound_received',
]);
export type ClaimEventType = z.infer<typeof ClaimEventTypeSchema>;

// Wire shapes for read APIs. Write APIs land alongside the claim CRUD
// slice (Slice J).

export const ClaimSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  caseId: z.string().uuid(),
  rail: ClaimRailSchema,
  status: ClaimStatusSchema,
  preauthAmount: z.number().int().nullable(),
  approvedAmount: z.number().int().nullable(),
  paidAmount: z.number().int().nullable(),
  payerRefNum: z.string().nullable(),
  preauthRefNum: z.string().nullable(),
  claimRefNum: z.string().nullable(),
  initiatedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
  // T2-15 — IRDAI SLA timers. Optional so callers that don't compute
  // it (list endpoints that skip the per-claim event scan) stay
  // wire-compatible. Case-detail responses always populate it.
  // ClaimSlaSchema is imported from sla.schema.ts — no circular
  // risk since sla.schema doesn't reference claim.schema.
  sla: ClaimSlaSchema.optional(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const ClaimEventSchema = z.object({
  id: z.string().uuid(),
  claimId: z.string().uuid(),
  eventType: ClaimEventTypeSchema,
  occurredAt: z.string().datetime(),
  recordedAt: z.string().datetime(),
  recordedById: z.string().uuid().nullable(),
  resultingStatus: ClaimStatusSchema,
  payload: z.record(z.unknown()),
});
export type ClaimEvent = z.infer<typeof ClaimEventSchema>;
