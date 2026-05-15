// T2-15 — SLA computation unit tests. Pure-function coverage of
// every state in the SLA status enum, plus boundary conditions.

import { computeSlaForClaim, type SlaEvent } from './sla-deadline';

function at(iso: string): Date {
  return new Date(iso);
}

const T0 = '2026-05-15T10:00:00Z'; // start time anchor

describe('computeSlaForClaim — preauth phase', () => {
  it('returns null preauth when no submitted_internally event', () => {
    const sla = computeSlaForClaim([], at('2026-05-15T11:00:00Z'));
    expect(sla.preauth).toBeNull();
    expect(sla.claim).toBeNull();
  });

  it('on_track when submitted, < 50% of window elapsed', () => {
    const events: SlaEvent[] = [
      { eventType: 'preauth.submitted_internally', occurredAt: at(T0) },
    ];
    // 20 minutes after start → 33% of 60-min window
    const sla = computeSlaForClaim(events, at('2026-05-15T10:20:00Z'));
    expect(sla.preauth?.status).toBe('on_track');
    expect(sla.preauth?.windowMinutes).toBe(60);
    expect(sla.preauth?.decidedAt).toBeNull();
    expect(sla.preauth?.msUntilDeadline).toBe(40 * 60_000);
  });

  it('at_risk when ≥ 50% of window elapsed', () => {
    const events: SlaEvent[] = [
      { eventType: 'preauth.submitted_internally', occurredAt: at(T0) },
    ];
    const sla = computeSlaForClaim(events, at('2026-05-15T10:31:00Z')); // 51.7%
    expect(sla.preauth?.status).toBe('at_risk');
  });

  it('breached when window has fully elapsed and no decision', () => {
    const events: SlaEvent[] = [
      { eventType: 'preauth.submitted_internally', occurredAt: at(T0) },
    ];
    const sla = computeSlaForClaim(events, at('2026-05-15T11:30:00Z')); // 1.5h
    expect(sla.preauth?.status).toBe('breached');
    // Overdue → negative msUntilDeadline.
    expect(sla.preauth?.msUntilDeadline).toBeLessThan(0);
  });

  it('met when decision arrives before deadline', () => {
    const events: SlaEvent[] = [
      { eventType: 'preauth.submitted_internally', occurredAt: at(T0) },
      { eventType: 'preauth.approved', occurredAt: at('2026-05-15T10:45:00Z') },
    ];
    const sla = computeSlaForClaim(events, at('2026-05-15T12:00:00Z'));
    expect(sla.preauth?.status).toBe('met');
    expect(sla.preauth?.decidedAt).toBe('2026-05-15T10:45:00.000Z');
    expect(sla.preauth?.msUntilDeadline).toBeNull();
  });

  it('missed when decision arrives after deadline', () => {
    const events: SlaEvent[] = [
      { eventType: 'preauth.submitted_internally', occurredAt: at(T0) },
      { eventType: 'preauth.approved', occurredAt: at('2026-05-15T11:30:00Z') },
    ];
    const sla = computeSlaForClaim(events, at('2026-05-15T12:00:00Z'));
    expect(sla.preauth?.status).toBe('missed');
    expect(sla.preauth?.decidedAt).toBe('2026-05-15T11:30:00.000Z');
  });

  it('query_received counts as a decision', () => {
    const events: SlaEvent[] = [
      { eventType: 'preauth.submitted_internally', occurredAt: at(T0) },
      { eventType: 'preauth.query_received', occurredAt: at('2026-05-15T10:30:00Z') },
    ];
    const sla = computeSlaForClaim(events, at('2026-05-15T11:00:00Z'));
    expect(sla.preauth?.status).toBe('met');
  });

  it('uses the EARLIEST submitted_internally if there are duplicates', () => {
    // PMJAY resubmit-on-query flow doesn't reset the SLA; the earliest
    // submit is the IRDAI-clocked event.
    const events: SlaEvent[] = [
      { eventType: 'preauth.submitted_internally', occurredAt: at('2026-05-15T10:00:00Z') },
      { eventType: 'preauth.submitted_internally', occurredAt: at('2026-05-15T11:00:00Z') },
    ];
    const sla = computeSlaForClaim(events, at('2026-05-15T10:20:00Z'));
    expect(sla.preauth?.startedAt).toBe('2026-05-15T10:00:00.000Z');
  });
});

describe('computeSlaForClaim — claim phase (3-hour window)', () => {
  it('on_track within 90 min', () => {
    const events: SlaEvent[] = [
      { eventType: 'claim.submitted_internally', occurredAt: at(T0) },
    ];
    const sla = computeSlaForClaim(events, at('2026-05-15T11:00:00Z')); // 1h elapsed = 33%
    expect(sla.claim?.status).toBe('on_track');
    expect(sla.claim?.windowMinutes).toBe(180);
  });

  it('at_risk past 90 min', () => {
    const events: SlaEvent[] = [
      { eventType: 'claim.submitted_internally', occurredAt: at(T0) },
    ];
    const sla = computeSlaForClaim(events, at('2026-05-15T11:35:00Z')); // 95min = 52.7%
    expect(sla.claim?.status).toBe('at_risk');
  });

  it('breached after 180 min', () => {
    const events: SlaEvent[] = [
      { eventType: 'claim.submitted_internally', occurredAt: at(T0) },
    ];
    const sla = computeSlaForClaim(events, at('2026-05-15T13:30:00Z')); // 3.5h
    expect(sla.claim?.status).toBe('breached');
  });

  it('met within 3-hour window', () => {
    const events: SlaEvent[] = [
      { eventType: 'claim.submitted_internally', occurredAt: at(T0) },
      { eventType: 'claim.partially_approved', occurredAt: at('2026-05-15T12:30:00Z') },
    ];
    const sla = computeSlaForClaim(events, at('2026-05-15T14:00:00Z'));
    expect(sla.claim?.status).toBe('met');
  });
});

describe('computeSlaForClaim — both phases together', () => {
  it('preauth met + claim on_track for a typical mid-stay snapshot', () => {
    const events: SlaEvent[] = [
      { eventType: 'preauth.submitted_internally', occurredAt: at('2026-05-15T09:00:00Z') },
      { eventType: 'preauth.approved', occurredAt: at('2026-05-15T09:30:00Z') },
      { eventType: 'claim.submitted_internally', occurredAt: at('2026-05-15T15:00:00Z') },
    ];
    const sla = computeSlaForClaim(events, at('2026-05-15T15:45:00Z'));
    expect(sla.preauth?.status).toBe('met');
    expect(sla.claim?.status).toBe('on_track');
  });

  it('ignores a stray decision that occurred BEFORE the start event', () => {
    // Defensive guard: an out-of-order event log shouldn't credit the
    // payer for a decision that pre-dates the submit.
    const events: SlaEvent[] = [
      { eventType: 'preauth.query_received', occurredAt: at('2026-05-15T08:00:00Z') },
      { eventType: 'preauth.submitted_internally', occurredAt: at('2026-05-15T10:00:00Z') },
    ];
    const sla = computeSlaForClaim(events, at('2026-05-15T10:30:00Z'));
    expect(sla.preauth?.decidedAt).toBeNull();
    // 30 min elapsed of 60min window = 50% → at_risk.
    expect(sla.preauth?.status).toBe('at_risk');
  });
});
