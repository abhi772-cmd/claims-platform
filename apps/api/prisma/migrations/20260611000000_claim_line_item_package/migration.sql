-- D-023 — PMJAY costing becomes package-driven.
--
-- Two changes:
--   1. claim.packageCode — denormalised PRIMARY package code (the
--      first `package` line) for list views + denial analytics. The
--      column was sketched in docs/03-data-model.md §"Case and claim"
--      from the start but never materialised; this lands it.
--   2. claim_line_item — the costing spine. For PMJAY each `package`
--      line is an HBP package at its fixed rate; `implant`/`addon`
--      lines carry the rest. unitAmount + display are snapshotted at
--      add-time (master-data versioning pattern, docs/03).
--
-- Phase 1 (this migration) is pure-additive: nothing reads
-- claim_line_item into a FHIR bundle yet — the Claim.item[] emission
-- is Phase 2 and deliberately quarantined so the locked snapshot /
-- contract tests stay green. Both changes are nullable / new-table,
-- so the migration round-trips cleanly.
--
-- Tenant-scoped via RLS-FORCE, same pattern as bill_line_item
-- (20260604000000).

ALTER TABLE "claim" ADD COLUMN "packageCode" TEXT;

-- The operator's package selection lives on the editable draft too, so
-- the picker round-trips on reload (the draft response is built from
-- this row). RLS for preauth_draft is already in place; adding a
-- nullable column inherits the table's existing policies.
ALTER TABLE "preauth_draft" ADD COLUMN "packageCode" TEXT;

CREATE TABLE "claim_line_item" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    -- 'package' | 'implant' | 'addon' (ClaimLineTypeSchema in contracts).
    "lineType" TEXT NOT NULL,
    -- HBP package code for pmjay package lines; internal code otherwise.
    "code" TEXT NOT NULL,
    -- Human-readable name, denormalised at add-time.
    "display" TEXT NOT NULL,
    -- 'nhcx' | 'pmjay' — selects the FHIR coding system in the builder.
    "rail" TEXT NOT NULL,
    -- Paise. For a package line = the HBP fixed rate at add-time.
    "unitAmount" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    -- Paise. Defaults to unitAmount * quantity; overridable for
    -- enhancement / implant lines (D-023: auto-fill, do NOT hard-lock).
    "requestedAmount" INTEGER NOT NULL,
    -- Paise, nullable — set from the payer's per-line adjudication.
    "approvedAmount" INTEGER,
    -- 'requested' | 'approved' | 'rejected' | 'partial'.
    "lineStatus" TEXT NOT NULL DEFAULT 'requested',
    -- Stable ordering → FHIR Claim.item[].sequence (1-based).
    "sequence" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "claim_line_item_pkey" PRIMARY KEY ("id")
);

-- One sequence number per claim — keeps FHIR Claim.item[].sequence
-- stable and rejects accidental duplicate inserts.
CREATE UNIQUE INDEX "claim_line_item_claimId_sequence_key"
  ON "claim_line_item"("claimId", "sequence");

CREATE INDEX "claim_line_item_tenantId_claimId_idx"
  ON "claim_line_item"("tenantId", "claimId");

ALTER TABLE "claim_line_item"
  ADD CONSTRAINT "claim_line_item_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE;

-- Cascade on claim delete — line items are scoped to a claim and have
-- no independent meaning. Matches bill_line_item / claim_event.
ALTER TABLE "claim_line_item"
  ADD CONSTRAINT "claim_line_item_claimId_fkey"
  FOREIGN KEY ("claimId") REFERENCES "claim"("id") ON DELETE CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "claim_line_item" TO claims_app;
  END IF;
END
$$;

ALTER TABLE "claim_line_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "claim_line_item" FORCE ROW LEVEL SECURITY;

CREATE POLICY claim_line_item_select ON "claim_line_item"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY claim_line_item_insert ON "claim_line_item"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
-- UPDATE permitted — payer per-line adjudication flips lineStatus /
-- approvedAmount, and the operator may re-cost a line. App-only.
CREATE POLICY claim_line_item_update ON "claim_line_item"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
-- DELETE permitted — the line-item upsert uses delete-then-insert
-- replace semantics on re-cost. Memory rule "RLS DELETE needs SELECT
-- policy" is satisfied by the SELECT policy above (DELETE WHERE-scan
-- reads through SELECT first).
CREATE POLICY claim_line_item_delete ON "claim_line_item"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
