// T2-15 — IRDAI SLA timer computation.
//
// Pure functions over a claim's event timeline. No DB access, no
// imports from NestJS — exists so unit tests can hammer it with
// synthetic event streams without spinning up Prisma. The
// CaseService calls `computeSlaForClaim()` at read time and stamps
// the result onto each claim in the case-detail response.

import {
  type ClaimSla,
  type ClaimEventType,
  type SlaPhase,
  type SlaState,
  type SlaStatus,
  IRDAI_PREAUTH_WINDOW_MINUTES,
  IRDAI_CLAIM_WINDOW_MINUTES,
} from '@claims/contracts';

const MS_PER_MINUTE = 60_000;

// Event types that start the SLA clock for each phase.
const PREAUTH_START_EVENT: ClaimEventType = 'preauth.submitted_internally';
const CLAIM_START_EVENT: ClaimEventType = 'claim.submitted_internally';

// Event types that STOP the SLA clock — payer's decision arrived.
// Query-received counts as a payer response (they've engaged); the
// SLA is met when the payer acknowledged within the window, even if
// the final disposition isn't approved yet.
const PREAUTH_DECISION_EVENTS: ReadonlySet<ClaimEventType> = new Set([
  'preauth.approved',
  'preauth.rejected',
  'preauth.partially_approved',
  'preauth.query_received',
]);
const CLAIM_DECISION_EVENTS: ReadonlySet<ClaimEventType> = new Set([
  'claim.approved',
  'claim.rejected',
  'claim.partially_approved',
  'claim.query_received',
]);

// Minimal event shape needed by the computation. Accepting just these
// fields keeps the function decoupled from Prisma row shape.
export interface SlaEvent {
  eventType: ClaimEventType;
  occurredAt: Date;
}

export function computeSlaForClaim(
  events: ReadonlyArray<SlaEvent>,
  now: Date = new Date(),
): ClaimSla {
  return {
    preauth: computePhase(
      'preauth',
      events,
      PREAUTH_START_EVENT,
      PREAUTH_DECISION_EVENTS,
      IRDAI_PREAUTH_WINDOW_MINUTES,
      now,
    ),
    claim: computePhase(
      'claim',
      events,
      CLAIM_START_EVENT,
      CLAIM_DECISION_EVENTS,
      IRDAI_CLAIM_WINDOW_MINUTES,
      now,
    ),
  };
}

function computePhase(
  phase: SlaPhase,
  events: ReadonlyArray<SlaEvent>,
  startEvent: ClaimEventType,
  decisionEvents: ReadonlySet<ClaimEventType>,
  windowMinutes: number,
  now: Date,
): SlaState | null {
  // Find the EARLIEST start event. The claim's first submission is
  // what IRDAI clocks against; resubmissions (PMJAY's preauth resubmit
  // flow) don't reset the SLA — that would let payers game the timer
  // by triggering queries.
  let startedAt: Date | null = null;
  for (const e of events) {
    if (e.eventType !== startEvent) continue;
    if (startedAt === null || e.occurredAt < startedAt) {
      startedAt = e.occurredAt;
    }
  }
  if (startedAt === null) return null;

  const deadlineAt = new Date(startedAt.getTime() + windowMinutes * MS_PER_MINUTE);

  // Find the earliest decision event AFTER the start. Defensive about
  // out-of-order events: only count decisions that occurred after the
  // start, not random earlier rows.
  let decidedAt: Date | null = null;
  for (const e of events) {
    if (!decisionEvents.has(e.eventType)) continue;
    if (e.occurredAt < startedAt) continue;
    if (decidedAt === null || e.occurredAt < decidedAt) {
      decidedAt = e.occurredAt;
    }
  }

  const status = computeStatus(startedAt, deadlineAt, decidedAt, now);
  const msUntilDeadline =
    status === 'met' || status === 'missed' ? null : deadlineAt.getTime() - now.getTime();

  return {
    phase,
    startedAt: startedAt.toISOString(),
    deadlineAt: deadlineAt.toISOString(),
    windowMinutes,
    status,
    decidedAt: decidedAt ? decidedAt.toISOString() : null,
    msUntilDeadline,
  };
}

function computeStatus(
  startedAt: Date,
  deadlineAt: Date,
  decidedAt: Date | null,
  now: Date,
): SlaStatus {
  if (decidedAt !== null) {
    return decidedAt <= deadlineAt ? 'met' : 'missed';
  }
  if (now >= deadlineAt) return 'breached';
  const elapsedFraction =
    (now.getTime() - startedAt.getTime()) / (deadlineAt.getTime() - startedAt.getTime());
  return elapsedFraction >= 0.5 ? 'at_risk' : 'on_track';
}
