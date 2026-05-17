-- EOB-line matcher Phase 2 — persisted reviewer-confirmed matches.
--
-- Phase 1 (PR #117) computed the deduction ↔ bill-line mapping
-- fresh on every read; nothing was stored. Phase 2 lets reviewers
-- confirm a suggestion so it sticks across reloads AND feeds
-- downstream consumers (e.g. appeal-drafting reads dispute
-- candidates from confirmed matches, not auto-suggestions).
--
-- Natural key: (claimId, deductionIndex). One confirmation per
-- payer-deduction. billLineItemId is nullable so reviewers can
-- record "no bill line matches this deduction" explicitly — that
-- decision is more valuable than letting the auto-suggest re-run.
-- isDispute is captured AT CONFIRM TIME from the bill row's
-- medical flag, not recomputed later; flipping the bill row's
-- medical doesn't retroactively change the appeal-grounds story.
--
-- Tenant-scoped via RLS-FORCE, same pattern as bill_line_item
-- (migration 20260604000000_bill_line_item).

CREATE TABLE "eob_line_match" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    -- Stable index into Settlement.deductions[]. Settlement uses
    -- a JSON column for deductions so there's no per-deduction id;
    -- the index is the only stable handle.
    "deductionIndex" INTEGER NOT NULL,
    -- Reviewer's confirmed mapping. Null = "no bill line matches
    -- this deduction" (operator reviewed and decided).
    "billLineItemId" UUID,
    -- Captured at confirm time. NOT recomputed from current
    -- bill_line_item.medical state — that drift could silently
    -- demote a confirmed dispute candidate, breaking the appeal
    -- audit trail.
    "isDispute" BOOLEAN NOT NULL DEFAULT FALSE,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedById" UUID NOT NULL,

    CONSTRAINT "eob_line_match_pkey" PRIMARY KEY ("id")
);

-- One confirmation per (claim, deductionIndex). Reviewer can
-- update by deleting + re-inserting (handled in the service).
CREATE UNIQUE INDEX "eob_line_match_claim_deduction_idx"
  ON "eob_line_match"("tenantId", "claimId", "deductionIndex");

-- Helps the "list confirmed matches for a claim" query that the
-- service runs on every matcher response.
CREATE INDEX "eob_line_match_tenantId_claimId_idx"
  ON "eob_line_match"("tenantId", "claimId");

ALTER TABLE "eob_line_match"
  ADD CONSTRAINT "eob_line_match_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE;

-- Cascade on claim delete — matches are scoped to a claim and
-- have no meaning outside it.
ALTER TABLE "eob_line_match"
  ADD CONSTRAINT "eob_line_match_claimId_fkey"
  FOREIGN KEY ("claimId") REFERENCES "claim"("id") ON DELETE CASCADE;

-- Cascade on bill_line_item delete too — if the operator deletes
-- their classified bill, any confirmations pointing at those rows
-- become meaningless. The reviewer can re-confirm against the
-- new bill if there is one.
ALTER TABLE "eob_line_match"
  ADD CONSTRAINT "eob_line_match_billLineItemId_fkey"
  FOREIGN KEY ("billLineItemId") REFERENCES "bill_line_item"("id") ON DELETE CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "eob_line_match" TO claims_app;
  END IF;
END
$$;

ALTER TABLE "eob_line_match" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "eob_line_match" FORCE ROW LEVEL SECURITY;

CREATE POLICY eob_line_match_select ON "eob_line_match"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY eob_line_match_insert ON "eob_line_match"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
-- UPDATE permitted for re-confirming a deduction (service does
-- delete-then-insert, but explicit policy keeps the row mutable
-- if a follow-up slice ever adds an in-place upsert).
CREATE POLICY eob_line_match_update ON "eob_line_match"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
-- DELETE permitted — reviewer resets a confirmation by clicking
-- the per-row reset button. Memory rule "RLS DELETE needs SELECT
-- policy" already satisfied by the SELECT policy above.
CREATE POLICY eob_line_match_delete ON "eob_line_match"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
