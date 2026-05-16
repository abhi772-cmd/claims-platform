import { computeRoomRentLiability } from './room-rent-liability';

describe('computeRoomRentLiability', () => {
  it('returns null when room rate is missing', () => {
    expect(
      computeRoomRentLiability({
        roomDailyRate: null,
        policyRoomRentLimit: 500_000,
        estimatedStayDays: 5,
      }),
    ).toBeNull();
  });

  it('returns null when policy limit is missing', () => {
    expect(
      computeRoomRentLiability({
        roomDailyRate: 800_000,
        policyRoomRentLimit: null,
        estimatedStayDays: 5,
      }),
    ).toBeNull();
  });

  it('returns zero liability when room is at the cap', () => {
    const out = computeRoomRentLiability({
      roomDailyRate: 500_000,
      policyRoomRentLimit: 500_000,
      estimatedStayDays: 3,
    });
    expect(out).toEqual({
      perDayLiability: 0,
      estimatedTotalLiability: 0,
      isOverLimit: false,
    });
  });

  it('returns zero liability when room is BELOW the cap (does not under-flow negative)', () => {
    const out = computeRoomRentLiability({
      roomDailyRate: 300_000,
      policyRoomRentLimit: 500_000,
      estimatedStayDays: 3,
    });
    expect(out).toEqual({
      perDayLiability: 0,
      estimatedTotalLiability: 0,
      isOverLimit: false,
    });
  });

  it('computes per-day differential when room exceeds the cap', () => {
    // ₹8000 actual − ₹5000 cap = ₹3000/day liability over 5 days = ₹15000 total.
    const out = computeRoomRentLiability({
      roomDailyRate: 800_000,
      policyRoomRentLimit: 500_000,
      estimatedStayDays: 5,
    });
    expect(out).toEqual({
      perDayLiability: 300_000,
      estimatedTotalLiability: 1_500_000,
      isOverLimit: true,
    });
  });

  it('omits the total projection when stayDays is missing but still returns per-day + isOverLimit', () => {
    const out = computeRoomRentLiability({
      roomDailyRate: 800_000,
      policyRoomRentLimit: 500_000,
      estimatedStayDays: null,
    });
    expect(out).toEqual({
      perDayLiability: 300_000,
      estimatedTotalLiability: null,
      isOverLimit: true,
    });
  });

  it('handles the policy-cap-is-zero edge case (self-pay-like) — liability is the full room rate', () => {
    const out = computeRoomRentLiability({
      roomDailyRate: 800_000,
      policyRoomRentLimit: 0,
      estimatedStayDays: 2,
    });
    expect(out).toEqual({
      perDayLiability: 800_000,
      estimatedTotalLiability: 1_600_000,
      isOverLimit: true,
    });
  });
});
