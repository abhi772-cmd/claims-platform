-- HCX correlation chain (doc 07 lines 99–117 / GAP_ANALYSIS.md row 6.2).
--
-- NHCX expects each participant to thread `x-hcx-correlation-id`
-- across the message lifecycle (insurance → coverage → preauth →
-- enhancement → discharge → claim → payment), so NHA-side
-- reporting groups every message of one case together. Until this
-- migration the Claim row only carried the payer-issued reference
-- numbers (preauthRefNum, claimRefNum, payerRefNum) — none of the
-- HCX-side correlation ids.
--
-- All seven columns are nullable: NULL until the matching stage
-- has fired for that claim. Partial indexes on the two hot
-- callback-dispatch paths (preauth/on_submit, claim/on_submit)
-- keep the index size proportional to the number of in-flight
-- claims rather than all claims ever opened.

ALTER TABLE "claim"
  ADD COLUMN "insuranceCorrelationId"   TEXT,
  ADD COLUMN "coverageCorrelationId"    TEXT,
  ADD COLUMN "preauthCorrelationId"     TEXT,
  ADD COLUMN "enhancementCorrelationId" TEXT,
  ADD COLUMN "dischargeCorrelationId"   TEXT,
  ADD COLUMN "claimCorrelationId"       TEXT,
  ADD COLUMN "paymentCorrelationId"     TEXT;

CREATE INDEX "claim_preauthCorrelationId_idx" ON "claim" ("preauthCorrelationId");
CREATE INDEX "claim_claimCorrelationId_idx"   ON "claim" ("claimCorrelationId");
