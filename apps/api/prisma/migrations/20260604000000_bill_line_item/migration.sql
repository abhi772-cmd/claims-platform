-- T2-13 follow-up — BillLineItem persistence.
--
-- Yesterday's PR #113 shipped an operator-aid calculator with no
-- persistence; the operator typed the bill into a textarea each
-- time. This migration adds a `bill_line_item` table so the
-- operator's classified bill is durable across sessions and
-- (later) reachable by the EOB-line matcher when the payer's
-- EOB lands.
--
-- Replace-all save semantics — the service deletes any existing
-- rows for the claim and inserts the new set atomically. We don't
-- track per-row update history; the audit_log row written by the
-- service captures the snapshot. If a fine-grained edit history
-- ever becomes interesting it's a follow-up.
--
-- Tenant-scoped via RLS-FORCE, same pattern as consent_record.

CREATE TABLE "bill_line_item" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    -- The operator's final tag (may differ from the classifier's
    -- current opinion if the operator overrode in the UI). Source
    -- of truth for downstream consumers (EOB-line matcher, etc.).
    "medical" BOOLEAN NOT NULL,
    -- Non-medical category from packages/contracts'
    -- NonMedicalCategorySchema. Null when `medical = true`.
    "category" TEXT,
    -- Classifier hint at save time — surfaced on the UI as
    -- "matched '<term>'" for operator confidence. Null when
    -- `medical = true` or when the operator overrode the
    -- classifier's miss with a manual tag.
    "matchedTerm" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID NOT NULL,

    CONSTRAINT "bill_line_item_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bill_line_item_tenantId_claimId_idx"
  ON "bill_line_item"("tenantId", "claimId");

ALTER TABLE "bill_line_item"
  ADD CONSTRAINT "bill_line_item_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE;

-- Cascade on claim delete — line items are scoped to a claim and
-- have no independent meaning. Matches the pattern used by
-- claim_event + integration_message.
ALTER TABLE "bill_line_item"
  ADD CONSTRAINT "bill_line_item_claimId_fkey"
  FOREIGN KEY ("claimId") REFERENCES "claim"("id") ON DELETE CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "bill_line_item" TO claims_app;
  END IF;
END
$$;

ALTER TABLE "bill_line_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bill_line_item" FORCE ROW LEVEL SECURITY;

CREATE POLICY bill_line_item_select ON "bill_line_item"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY bill_line_item_insert ON "bill_line_item"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
-- UPDATE permitted because we may want to flip the operator's
-- `medical` override after the fact; the application is the only
-- one issuing UPDATEs.
CREATE POLICY bill_line_item_update ON "bill_line_item"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
-- DELETE permitted (we deliberately delete-then-insert on save).
-- Memory rule "RLS DELETE needs SELECT policy" already satisfied
-- by the SELECT policy above — DELETE WHERE-scan reads through
-- SELECT first.
CREATE POLICY bill_line_item_delete ON "bill_line_item"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
