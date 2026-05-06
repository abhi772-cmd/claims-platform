-- Persists payerCode on the Claim row so phase services
-- (preauth, discharge, claim-submit, communication) can build the
-- coverage actor for the outbound FHIR R4 Bundle without taking
-- payerCode on every request.
--
-- Nullable so legacy claims (created before this slice) remain valid.
-- EligibilityService stamps it at eligibility.requested transition;
-- it never changes after that.

ALTER TABLE "claim" ADD COLUMN "payerCode" TEXT;
