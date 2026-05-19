-- Phase 3 — per-payer capability flag for NHCX mobile discovery.
-- A handful of NHCX private payers (Star, HDFC) accept a 10-digit
-- mobile as the sole identifier on /coverageeligibility/$check.
-- Most don't. This boolean opts in payers individually so the UI
-- only surfaces the mobile picker when it'll actually work.
--
-- PMJAY rows keep the default false — PMJAY mobile discovery uses
-- /pmjay/policies/lookup, not the eligibility surface.

ALTER TABLE "payer"
  ADD COLUMN "supportsDiscoveryByMobile" BOOLEAN NOT NULL DEFAULT false;
