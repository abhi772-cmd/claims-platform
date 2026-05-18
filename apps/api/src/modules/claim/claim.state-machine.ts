import {
  type ClaimEventType,
  type ClaimStatus,
} from '@claims/contracts';

// Transition table — directly from docs/04-state-machines.md.
//
// Shape: each row is `(fromStatus, eventType) → toStatus`. We keep this
// as an explicit array (vs a nested map) so a reviewer can read it in
// the same order the doc presents the phases. The lookup map is
// derived once at module load.
//
// `null` in `from` means "the claim doesn't exist yet" — i.e. case.created
// is the only event that creates a claim. Every other event requires a
// claim already in the listed `from` status.
interface Transition {
  from: ClaimStatus | null;
  event: ClaimEventType;
  to: ClaimStatus;
}

const TRANSITIONS: readonly Transition[] = [
  // -- creation --
  { from: null,                                event: 'case.created',                  to: 'INITIATED' },

  // -- eligibility --
  { from: 'INITIATED',                         event: 'eligibility.requested',         to: 'ELIGIBILITY_CHECK_PENDING' },
  { from: 'ELIGIBILITY_CHECK_PENDING',         event: 'eligibility.verified',          to: 'ELIGIBILITY_VERIFIED' },
  { from: 'ELIGIBILITY_CHECK_PENDING',         event: 'eligibility.failed',            to: 'ELIGIBILITY_FAILED' },
  { from: 'ELIGIBILITY_FAILED',                event: 'eligibility.retry',             to: 'ELIGIBILITY_CHECK_PENDING' },
  { from: 'ELIGIBILITY_FAILED',                event: 'case.abandoned',                to: 'ABANDONED' },

  // -- preauth --
  { from: 'ELIGIBILITY_VERIFIED',              event: 'preauth.drafting_started',      to: 'PREAUTH_DRAFTING' },
  { from: 'PREAUTH_DRAFTING',                  event: 'preauth.submitted_internally',  to: 'PREAUTH_QUEUED' },
  { from: 'PREAUTH_QUEUED',                    event: 'preauth.acknowledged_by_payer', to: 'PREAUTH_SUBMITTED' },
  { from: 'PREAUTH_QUEUED',                    event: 'preauth.submission_failed',     to: 'PREAUTH_DRAFTING' },
  { from: 'PREAUTH_SUBMITTED',                 event: 'preauth.query_received',        to: 'PREAUTH_QUERY_RAISED' },
  { from: 'PREAUTH_SUBMITTED',                 event: 'preauth.approved',              to: 'PREAUTH_APPROVED' },
  { from: 'PREAUTH_SUBMITTED',                 event: 'preauth.rejected',              to: 'PREAUTH_REJECTED' },
  { from: 'PREAUTH_SUBMITTED',                 event: 'preauth.partially_approved',    to: 'PREAUTH_PARTIALLY_APPROVED' },
  { from: 'PREAUTH_QUERY_RAISED',              event: 'preauth.query_responded',       to: 'PREAUTH_QUERY_RESPONDED' },
  // Slice BL — PMJAY operators don't respond to queries via
  // Communication; they re-submit. The preauth controller route
  // gates on `tenant.pmjayMode === 'on'`; the transition itself
  // is rail-agnostic (private-rail tenants could still reach it
  // through the /transitions admin escape hatch if they want, but
  // the documented path is "respond via Communication").
  { from: 'PREAUTH_QUERY_RAISED',              event: 'preauth.resubmission_started',  to: 'PREAUTH_DRAFTING' },
  { from: 'PREAUTH_QUERY_RESPONDED',           event: 'preauth.approved',              to: 'PREAUTH_APPROVED' },
  { from: 'PREAUTH_QUERY_RESPONDED',           event: 'preauth.query_received',        to: 'PREAUTH_QUERY_RAISED' },
  { from: 'PREAUTH_QUERY_RESPONDED',           event: 'preauth.rejected',              to: 'PREAUTH_REJECTED' },
  { from: 'PREAUTH_QUERY_RESPONDED',           event: 'preauth.partially_approved',    to: 'PREAUTH_PARTIALLY_APPROVED' },
  // Slice BH — PMJAY preauth cancel via outbound task/submit. The
  // operator can cancel any preauth that's been submitted (queued or
  // acknowledged) but not yet decisioned. PMJAY-only in v1; the
  // controller gates on tenant.pmjayMode.
  { from: 'PREAUTH_QUEUED',                    event: 'preauth.cancelled',             to: 'PREAUTH_CANCELLED' },
  { from: 'PREAUTH_SUBMITTED',                 event: 'preauth.cancelled',             to: 'PREAUTH_CANCELLED' },
  { from: 'PREAUTH_QUERY_RAISED',              event: 'preauth.cancelled',             to: 'PREAUTH_CANCELLED' },
  { from: 'PREAUTH_QUERY_RESPONDED',           event: 'preauth.cancelled',             to: 'PREAUTH_CANCELLED' },
  { from: 'PREAUTH_CANCELLED',                 event: 'case.abandoned',                to: 'ABANDONED' },
  { from: 'PREAUTH_REJECTED',                  event: 'appeal.started',                to: 'APPEAL_INITIATED' },
  { from: 'PREAUTH_REJECTED',                  event: 'case.abandoned',                to: 'ABANDONED' },
  { from: 'PREAUTH_PARTIALLY_APPROVED',        event: 'enhancement.drafting_started',  to: 'ENHANCEMENT_DRAFTING' },
  { from: 'PREAUTH_PARTIALLY_APPROVED',        event: 'discharge.initiated',           to: 'DISCHARGE_PENDING' },
  { from: 'PREAUTH_APPROVED',                  event: 'enhancement.drafting_started',  to: 'ENHANCEMENT_DRAFTING' },
  { from: 'PREAUTH_APPROVED',                  event: 'discharge.initiated',           to: 'DISCHARGE_PENDING' },

  // -- enhancement --
  { from: 'ENHANCEMENT_DRAFTING',              event: 'enhancement.submitted_internally', to: 'ENHANCEMENT_QUEUED' },
  { from: 'ENHANCEMENT_QUEUED',                event: 'enhancement.acknowledged',      to: 'ENHANCEMENT_SUBMITTED' },
  { from: 'ENHANCEMENT_SUBMITTED',             event: 'enhancement.approved',          to: 'ENHANCEMENT_APPROVED' },
  { from: 'ENHANCEMENT_SUBMITTED',             event: 'enhancement.rejected',          to: 'ENHANCEMENT_REJECTED' },
  { from: 'ENHANCEMENT_APPROVED',              event: 'discharge.initiated',           to: 'DISCHARGE_PENDING' },
  { from: 'ENHANCEMENT_REJECTED',              event: 'discharge.initiated',           to: 'DISCHARGE_PENDING' },

  // -- discharge --
  { from: 'DISCHARGE_PENDING',                 event: 'discharge.submitted',           to: 'DISCHARGE_SUBMITTED' },
  // P2.20 — PMJAY rail: same terminal status, no outbound wire-call.
  // DischargeService.submit() fires this when claim.primaryRail==='pmjay'.
  { from: 'DISCHARGE_PENDING',                 event: 'discharge.skipped',             to: 'DISCHARGE_SUBMITTED' },
  { from: 'DISCHARGE_SUBMITTED',               event: 'claim.drafting_started',        to: 'CLAIM_DRAFTING' },

  // -- claim --
  { from: 'CLAIM_DRAFTING',                    event: 'claim.submitted_internally',    to: 'CLAIM_QUEUED' },
  { from: 'CLAIM_QUEUED',                      event: 'claim.acknowledged',            to: 'CLAIM_SUBMITTED' },
  { from: 'CLAIM_SUBMITTED',                   event: 'claim.query_received',          to: 'CLAIM_QUERY_RAISED' },
  { from: 'CLAIM_SUBMITTED',                   event: 'claim.approved',                to: 'CLAIM_APPROVED' },
  { from: 'CLAIM_SUBMITTED',                   event: 'claim.rejected',                to: 'CLAIM_REJECTED' },
  { from: 'CLAIM_SUBMITTED',                   event: 'claim.partially_approved',      to: 'CLAIM_PARTIALLY_APPROVED' },
  { from: 'CLAIM_QUERY_RAISED',                event: 'claim.query_responded',         to: 'CLAIM_QUERY_RESPONDED' },
  // Slice BL — PMJAY claim re-submit on query. Mirrors the preauth
  // pull-back; the claim-submit controller route gates on
  // `tenant.pmjayMode === 'on'`.
  { from: 'CLAIM_QUERY_RAISED',                event: 'claim.resubmission_started',    to: 'CLAIM_DRAFTING' },
  { from: 'CLAIM_QUERY_RESPONDED',             event: 'claim.approved',                to: 'CLAIM_APPROVED' },
  { from: 'CLAIM_QUERY_RESPONDED',             event: 'claim.rejected',                to: 'CLAIM_REJECTED' },
  { from: 'CLAIM_QUERY_RESPONDED',             event: 'claim.partially_approved',      to: 'CLAIM_PARTIALLY_APPROVED' },

  // -- payment / settlement --
  { from: 'CLAIM_APPROVED',                    event: 'payment.expected',              to: 'PAYMENT_PENDING' },
  { from: 'CLAIM_PARTIALLY_APPROVED',          event: 'payment.expected',              to: 'PAYMENT_PENDING' },
  { from: 'PAYMENT_PENDING',                   event: 'payment.received',              to: 'PAYMENT_RECEIVED' },
  { from: 'PAYMENT_RECEIVED',                  event: 'payment.reconciled',            to: 'PAYMENT_RECONCILED' },
  { from: 'PAYMENT_RECEIVED',                  event: 'payment.short_paid',            to: 'SHORT_PAID' },
  { from: 'PAYMENT_RECONCILED',                event: 'claim.closed',                  to: 'CLOSED' },
  { from: 'SHORT_PAID',                        event: 'appeal.started',                to: 'APPEAL_INITIATED' },
  { from: 'SHORT_PAID',                        event: 'claim.written_off',             to: 'WRITTEN_OFF' },
  { from: 'WRITTEN_OFF',                       event: 'claim.closed',                  to: 'CLOSED' },
  { from: 'CLAIM_REJECTED',                    event: 'appeal.started',                to: 'APPEAL_INITIATED' },
  { from: 'CLAIM_REJECTED',                    event: 'claim.written_off',             to: 'WRITTEN_OFF' },
  // Slice BI — PMJAY CRC reprocess via outbound task/submit.
  // Reachable from CLAIM_REJECTED (reasonCode='claimrejected') and
  // SHORT_PAID (reasonCode='partialpayment'). The payer's
  // re-decision flows back through the existing claim/on_submit
  // inbound handler, which re-runs the standard
  // approved/rejected/partially_approved transitions.
  { from: 'CLAIM_REJECTED',                    event: 'claim.reprocess_requested',     to: 'CLAIM_REPROCESS_REQUESTED' },
  { from: 'SHORT_PAID',                        event: 'claim.reprocess_requested',     to: 'CLAIM_REPROCESS_REQUESTED' },
  { from: 'CLAIM_REPROCESS_REQUESTED',         event: 'claim.approved',                to: 'CLAIM_APPROVED' },
  { from: 'CLAIM_REPROCESS_REQUESTED',         event: 'claim.rejected',                to: 'CLAIM_REJECTED' },
  { from: 'CLAIM_REPROCESS_REQUESTED',         event: 'claim.partially_approved',      to: 'CLAIM_PARTIALLY_APPROVED' },
  { from: 'CLAIM_REPROCESS_REQUESTED',         event: 'claim.query_received',          to: 'CLAIM_QUERY_RAISED' },

  // -- appeal --
  { from: 'APPEAL_INITIATED',                  event: 'appeal.submitted',              to: 'APPEAL_SUBMITTED' },
  { from: 'APPEAL_SUBMITTED',                  event: 'appeal.resolved',               to: 'APPEAL_RESOLVED' },
  { from: 'APPEAL_RESOLVED',                   event: 'payment.expected',              to: 'PAYMENT_PENDING' },
  { from: 'APPEAL_RESOLVED',                   event: 'claim.written_off',             to: 'WRITTEN_OFF' },
];

// Lookup index: key = `${from ?? '__null__'}::${eventType}`.
const TRANSITION_INDEX: ReadonlyMap<string, ClaimStatus> = (() => {
  const m = new Map<string, ClaimStatus>();
  for (const t of TRANSITIONS) {
    const key = `${t.from ?? '__null__'}::${t.event}`;
    if (m.has(key)) {
      throw new Error(
        `Duplicate transition (${t.from ?? 'null'}, ${t.event}) — only one target allowed.`,
      );
    }
    m.set(key, t.to);
  }
  return m;
})();

// Returns the resulting status if (from, event) is a valid transition,
// or null if the event is not allowed from the given status.
export function nextStatus(
  from: ClaimStatus | null,
  event: ClaimEventType,
): ClaimStatus | null {
  return TRANSITION_INDEX.get(`${from ?? '__null__'}::${event}`) ?? null;
}

export function isTransitionAllowed(
  from: ClaimStatus | null,
  event: ClaimEventType,
): boolean {
  return nextStatus(from, event) !== null;
}

// All event types valid from a given status — useful for the UI to grey
// out buttons the executive can't currently click.
export function allowedEventsFrom(from: ClaimStatus | null): readonly ClaimEventType[] {
  const out: ClaimEventType[] = [];
  for (const t of TRANSITIONS) {
    if (t.from === from) out.push(t.event);
  }
  return out;
}

export const TERMINAL_STATUSES: ReadonlySet<ClaimStatus> = new Set(['CLOSED', 'ABANDONED']);

// Useful for tests + the integration suite — full export of the
// transition table read-only.
export const ALL_TRANSITIONS = TRANSITIONS;
