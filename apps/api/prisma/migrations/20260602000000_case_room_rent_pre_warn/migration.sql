-- T2-14 — room rent sub-limit pre-warn.
--
-- Operator captures the room's actual daily rate (paise) and the
-- policy's per-day room rent cap (paise) at intake. When the room
-- rate exceeds the policy cap, the patient family is liable for
-- the per-day differential plus, in most Indian policies, a
-- proportionate deduction on associated services. The web app
-- shows a pre-warn banner with the math so the family is told
-- BEFORE admission rather than at discharge.
--
-- All three columns are nullable: an operator can still create
-- a case without filling them (emergency intake, partial info,
-- self-pay where no policy cap exists), and the UI only renders
-- the warning when both the room rate and the cap are present.
--
-- Paise convention matches existing money columns on Claim
-- (preauthAmount / claimAmount / etc.). estimatedStayDays is the
-- planned length of stay used to project the total out-of-pocket;
-- when null the UI falls back to per-day liability only.

ALTER TABLE "case"
  ADD COLUMN "roomDailyRate"        INTEGER,
  ADD COLUMN "policyRoomRentLimit"  INTEGER,
  ADD COLUMN "estimatedStayDays"    INTEGER;
