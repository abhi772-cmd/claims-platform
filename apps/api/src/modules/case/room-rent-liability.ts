// T2-14 — pure liability math for the room rent sub-limit pre-warn.
//
// Indian health policies typically cap "room rent" per day. When the
// actual room exceeds that cap, the family is liable for the per-day
// differential AND, in most policies, a proportionate deduction
// applies to the entire bill (consumables, doctor visits, etc.). The
// proportionate-deduction multiplier is policy-specific and not
// captured here — the pre-warn only computes the visible room-rent
// shortfall, since that's the only number the operator can quote
// with certainty at admission.
//
// All amounts are paise (Int) to match the existing money convention
// on Claim.preauthAmount / Claim.claimAmount.

export interface RoomRentInputs {
  /** Actual daily rate of the assigned room, in paise. Null = unknown. */
  roomDailyRate: number | null;
  /** Policy's per-day room rent cap, in paise. Null = unknown. */
  policyRoomRentLimit: number | null;
  /** Planned length of stay in days. Null = unknown. */
  estimatedStayDays: number | null;
}

export interface RoomRentLiability {
  /** Per-day differential the family bears, in paise. Always ≥ 0. */
  perDayLiability: number;
  /**
   * Projected total liability over the planned stay, in paise.
   * Null when estimatedStayDays is null (we don't know how to project).
   */
  estimatedTotalLiability: number | null;
  /** True when the per-day liability is strictly positive. */
  isOverLimit: boolean;
}

/**
 * Compute room rent liability for the pre-warn banner.
 *
 * Returns null when EITHER rate or limit is missing — the warning
 * can only be drawn when both ends of the comparison are known.
 * When the room is at or below the cap, returns a zeroed
 * liability (not null) so callers can distinguish "we checked,
 * patient is safe" from "we have no information."
 */
export function computeRoomRentLiability(input: RoomRentInputs): RoomRentLiability | null {
  if (input.roomDailyRate === null || input.policyRoomRentLimit === null) return null;
  const perDayLiability = Math.max(0, input.roomDailyRate - input.policyRoomRentLimit);
  const estimatedTotalLiability =
    input.estimatedStayDays !== null ? perDayLiability * input.estimatedStayDays : null;
  return {
    perDayLiability,
    estimatedTotalLiability,
    isOverLimit: perDayLiability > 0,
  };
}
