import { computeNextEligibleAt } from './notification-retry.worker';

describe('computeNextEligibleAt', () => {
  const base = new Date('2026-05-05T12:00:00.000Z');

  it('attempt 0 → eligible immediately', () => {
    expect(computeNextEligibleAt(base, 0).getTime()).toBe(base.getTime());
  });

  it('attempt 1 → +60s', () => {
    expect(computeNextEligibleAt(base, 1).getTime()).toBe(base.getTime() + 60_000);
  });

  it('attempt 2 → +5m', () => {
    expect(computeNextEligibleAt(base, 2).getTime()).toBe(base.getTime() + 5 * 60_000);
  });

  it('attempt 3 → +30m', () => {
    expect(computeNextEligibleAt(base, 3).getTime()).toBe(base.getTime() + 30 * 60_000);
  });

  it('attempt 4 → +2h', () => {
    expect(computeNextEligibleAt(base, 4).getTime()).toBe(base.getTime() + 2 * 60 * 60_000);
  });

  it('attempts beyond the schedule clamp to the last entry', () => {
    expect(computeNextEligibleAt(base, 99).getTime()).toBe(base.getTime() + 2 * 60 * 60_000);
  });
});
