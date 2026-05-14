-- Slice 1 of the onboarding spec diff (docs/15) — extend the tenant
-- profile with the fields the Stage 1 ops form needs to capture:
-- ROHINI ID, hospital type, bed count, HMIS in use, expected claims
-- volume band. All additive + nullable so existing tenants don't
-- need a backfill — they pre-date this slice and will fill these
-- in via the onboarding wizard when next touched.

CREATE TYPE "HospitalType" AS ENUM ('private', 'trust', 'government', 'psu');

CREATE TYPE "ExpectedMonthlyClaimsBand" AS ENUM ('lt_100', 'band_100_500', 'band_500_2000', 'gt_2000');

ALTER TABLE "tenant"
  ADD COLUMN "legalName" TEXT,
  ADD COLUMN "rohiniId" TEXT,
  ADD COLUMN "hospitalType" "HospitalType",
  ADD COLUMN "bedCount" INTEGER,
  ADD COLUMN "hmisVendor" TEXT,
  ADD COLUMN "expectedMonthlyClaimsBand" "ExpectedMonthlyClaimsBand";

-- ROHINI ID is the only field with a stable format check we can add at
-- the DB level — 9-digit numeric string per the IRDAI registry. NULL
-- still allowed because some hospitals are PMJAY-only and never
-- registered with ROHINI; the application enforces "required for NHCX
-- enablement" higher up in readiness.
ALTER TABLE "tenant"
  ADD CONSTRAINT "tenant_rohini_id_format"
    CHECK ("rohiniId" IS NULL OR "rohiniId" ~ '^[0-9]{9}$');

ALTER TABLE "tenant"
  ADD CONSTRAINT "tenant_bed_count_positive"
    CHECK ("bedCount" IS NULL OR "bedCount" > 0);
