-- T2-8 — ICU upgrade auto-enhancement (ward tier tracker).
--
-- The existing roomDailyRate column (added in T2-14 migration
-- 20260602000000_case_room_rent_pre_warn) captures the room's
-- daily rate AT ADMISSION. T2-8 needs a separate column for the
-- CURRENT room rate so the case-detail page can detect upgrades
-- (current > admission) and auto-suggest a preauth enhancement.
--
-- Nullable Int (paise), same convention as roomDailyRate. NULL
-- means "not yet tracked" — case-detail falls back to assuming
-- room hasn't changed since admission.

ALTER TABLE "case"
  ADD COLUMN "currentRoomDailyRate" INTEGER;
