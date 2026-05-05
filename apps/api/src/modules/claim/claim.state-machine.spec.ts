import {
  ALL_TRANSITIONS,
  allowedEventsFrom,
  isTransitionAllowed,
  nextStatus,
  TERMINAL_STATUSES,
} from './claim.state-machine';

describe('claim.state-machine', () => {
  it('case.created drives null → INITIATED and is the only creation event', () => {
    expect(nextStatus(null, 'case.created')).toBe('INITIATED');
    // No other event should be valid from null.
    const fromNull = ALL_TRANSITIONS.filter((t) => t.from === null);
    expect(fromNull.map((t) => t.event)).toEqual(['case.created']);
  });

  it('every (from, event) pair is unique in the table', () => {
    const seen = new Set<string>();
    for (const t of ALL_TRANSITIONS) {
      const key = `${t.from ?? '__null__'}::${t.event}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('terminal states have no outbound transitions', () => {
    for (const terminal of TERMINAL_STATUSES) {
      expect(allowedEventsFrom(terminal)).toEqual([]);
    }
  });

  it.each([
    ['INITIATED', 'eligibility.requested', 'ELIGIBILITY_CHECK_PENDING'],
    ['ELIGIBILITY_CHECK_PENDING', 'eligibility.verified', 'ELIGIBILITY_VERIFIED'],
    ['ELIGIBILITY_VERIFIED', 'preauth.drafting_started', 'PREAUTH_DRAFTING'],
    ['PREAUTH_DRAFTING', 'preauth.submitted_internally', 'PREAUTH_QUEUED'],
    ['PREAUTH_QUEUED', 'preauth.acknowledged_by_payer', 'PREAUTH_SUBMITTED'],
    ['PREAUTH_SUBMITTED', 'preauth.approved', 'PREAUTH_APPROVED'],
    ['PREAUTH_APPROVED', 'discharge.initiated', 'DISCHARGE_PENDING'],
    ['DISCHARGE_PENDING', 'discharge.submitted', 'DISCHARGE_SUBMITTED'],
    ['DISCHARGE_SUBMITTED', 'claim.drafting_started', 'CLAIM_DRAFTING'],
    ['CLAIM_SUBMITTED', 'claim.approved', 'CLAIM_APPROVED'],
    ['CLAIM_APPROVED', 'payment.expected', 'PAYMENT_PENDING'],
    ['PAYMENT_PENDING', 'payment.received', 'PAYMENT_RECEIVED'],
    ['PAYMENT_RECEIVED', 'payment.reconciled', 'PAYMENT_RECONCILED'],
    ['PAYMENT_RECONCILED', 'claim.closed', 'CLOSED'],
  ] as const)('happy path: %s + %s → %s', (from, event, to) => {
    expect(nextStatus(from, event)).toBe(to);
    expect(isTransitionAllowed(from, event)).toBe(true);
  });

  it('rejects skipping ahead (INITIATED → preauth.approved)', () => {
    expect(isTransitionAllowed('INITIATED', 'preauth.approved')).toBe(false);
    expect(nextStatus('INITIATED', 'preauth.approved')).toBe(null);
  });

  it('rejects retrograde transitions (PAYMENT_RECONCILED → preauth.drafting_started)', () => {
    expect(isTransitionAllowed('PAYMENT_RECONCILED', 'preauth.drafting_started')).toBe(false);
  });

  it('rejects events from terminal states', () => {
    expect(isTransitionAllowed('CLOSED', 'appeal.started')).toBe(false);
    expect(isTransitionAllowed('ABANDONED', 'eligibility.retry')).toBe(false);
  });

  it('preauth query loop: SUBMITTED ↔ QUERY_RAISED ↔ QUERY_RESPONDED with re-query', () => {
    expect(nextStatus('PREAUTH_SUBMITTED', 'preauth.query_received')).toBe(
      'PREAUTH_QUERY_RAISED',
    );
    expect(nextStatus('PREAUTH_QUERY_RAISED', 'preauth.query_responded')).toBe(
      'PREAUTH_QUERY_RESPONDED',
    );
    // Second query after the first response loops back.
    expect(nextStatus('PREAUTH_QUERY_RESPONDED', 'preauth.query_received')).toBe(
      'PREAUTH_QUERY_RAISED',
    );
  });

  it('appeal flow: rejection → appeal → resolved → payment_pending', () => {
    expect(nextStatus('CLAIM_REJECTED', 'appeal.started')).toBe('APPEAL_INITIATED');
    expect(nextStatus('APPEAL_INITIATED', 'appeal.submitted')).toBe('APPEAL_SUBMITTED');
    expect(nextStatus('APPEAL_SUBMITTED', 'appeal.resolved')).toBe('APPEAL_RESOLVED');
    expect(nextStatus('APPEAL_RESOLVED', 'payment.expected')).toBe('PAYMENT_PENDING');
  });

  it('short-paid flow has two resolutions: appeal or write-off', () => {
    expect(nextStatus('SHORT_PAID', 'appeal.started')).toBe('APPEAL_INITIATED');
    expect(nextStatus('SHORT_PAID', 'claim.written_off')).toBe('WRITTEN_OFF');
    expect(nextStatus('WRITTEN_OFF', 'claim.closed')).toBe('CLOSED');
  });

  it('allowedEventsFrom returns at least one option for every non-terminal status', () => {
    const allFroms = new Set(
      ALL_TRANSITIONS.flatMap((t) => (t.from === null ? [] : [t.from])),
    );
    for (const from of allFroms) {
      if (TERMINAL_STATUSES.has(from)) continue;
      expect(allowedEventsFrom(from).length).toBeGreaterThan(0);
    }
  });
});
