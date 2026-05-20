-- Co-pay floor-vs-cap modelling on payer_commercial_terms.
--
-- When both copayPercent and copayFlatPaise are set, the MOU phrasing
-- decides how they combine:
--   'cap'   — "10% capped at ₹50,000"  → patient pays min(percent, flat)
--   'floor' — "10%, minimum ₹5,000"    → patient pays max(percent, flat)
-- NULL/ignored when only one of the two is present.
--
-- Nullable, no default — existing rows keep NULL (single-value co-pay
-- or none), so no backfill needed and the out-of-pocket math falls
-- back to whichever single value is set.

ALTER TABLE "payer_commercial_terms"
  ADD COLUMN "copayFlatMode" TEXT;
