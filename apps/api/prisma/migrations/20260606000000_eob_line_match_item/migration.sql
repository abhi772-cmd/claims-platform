-- EOB-line matcher Phase 3 — multi-line matches.
--
-- Phase 2 stored at most one bill_line_item per payer deduction.
-- A category strip ("non_payable_items: ₹2,500") often maps to
-- many hospital rows (toiletry + tv-rental + attendant-food +
-- comfort + admin-fees summing to ₹2,500). Phase 3 records the
-- ADDITIONAL bill lines beyond the primary as join rows here.
--
-- Model:
--   eob_line_match.billLineItemId stays — the "primary" / first
--     subset member, kept for back-compat and so single-line
--     matches don't grow a join row for nothing.
--   eob_line_match_item rows = additional subset members. One
--     row per (eob_line_match_id, bill_line_item_id) pair.
--
-- Cascades: a row dies when EITHER its parent eob_line_match OR
-- its referenced bill_line_item dies. Either side disappearing
-- makes the join meaningless.
--
-- RLS-FORCE, same tenant-id pattern as eob_line_match.

CREATE TABLE "eob_line_match_item" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "eobLineMatchId" UUID NOT NULL,
    "billLineItemId" UUID NOT NULL,

    CONSTRAINT "eob_line_match_item_pkey" PRIMARY KEY ("id")
);

-- One join entry per (match, bill_line). Same bill line CAN appear
-- in multiple matches across different deductions (e.g. a single
-- bill line that overlaps two payer deduction lines is rare but
-- legal); the constraint scopes uniqueness to within one match.
CREATE UNIQUE INDEX "eob_line_match_item_match_bill_idx"
  ON "eob_line_match_item"("eobLineMatchId", "billLineItemId");

CREATE INDEX "eob_line_match_item_tenantId_eobLineMatchId_idx"
  ON "eob_line_match_item"("tenantId", "eobLineMatchId");

ALTER TABLE "eob_line_match_item"
  ADD CONSTRAINT "eob_line_match_item_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE;

ALTER TABLE "eob_line_match_item"
  ADD CONSTRAINT "eob_line_match_item_eobLineMatchId_fkey"
  FOREIGN KEY ("eobLineMatchId") REFERENCES "eob_line_match"("id") ON DELETE CASCADE;

ALTER TABLE "eob_line_match_item"
  ADD CONSTRAINT "eob_line_match_item_billLineItemId_fkey"
  FOREIGN KEY ("billLineItemId") REFERENCES "bill_line_item"("id") ON DELETE CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "eob_line_match_item" TO claims_app;
  END IF;
END
$$;

ALTER TABLE "eob_line_match_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "eob_line_match_item" FORCE ROW LEVEL SECURITY;

CREATE POLICY eob_line_match_item_select ON "eob_line_match_item"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY eob_line_match_item_insert ON "eob_line_match_item"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY eob_line_match_item_update ON "eob_line_match_item"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
-- DELETE permitted — the service deletes-then-inserts on
-- re-confirmation of a multi-line match. Memory rule "RLS DELETE
-- needs SELECT policy" already satisfied above.
CREATE POLICY eob_line_match_item_delete ON "eob_line_match_item"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
