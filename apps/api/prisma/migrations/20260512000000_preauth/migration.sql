-- Slice L — pre-auth phase.
--   * preauth_draft: editable form, one row per claim.
--   * preauth_query: payer-raised queries on a pre-auth.

-- CreateTable: preauth_draft
CREATE TABLE "preauth_draft" (
    "id"                        UUID NOT NULL,
    "tenantId"                  UUID NOT NULL,
    "claimId"                   UUID NOT NULL,
    "diagnosisIcdCode"          TEXT,
    "diagnosisDescription"      TEXT,
    "plannedProcedure"          TEXT,
    "procedureCode"             TEXT,
    "estimatedLengthOfStayDays" INTEGER,
    "requestedAmount"           INTEGER,
    "clinicalJustification"     TEXT,
    "submittedAt"               TIMESTAMP(3),
    "submittedSnapshot"         JSONB,
    "createdAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                 TIMESTAMP(3) NOT NULL,

    CONSTRAINT "preauth_draft_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "preauth_draft_claimId_key" ON "preauth_draft"("claimId");
CREATE INDEX "preauth_draft_tenantId_claimId_idx"
  ON "preauth_draft"("tenantId", "claimId");

-- CreateTable: preauth_query
CREATE TABLE "preauth_query" (
    "id"            UUID NOT NULL,
    "tenantId"      UUID NOT NULL,
    "claimId"       UUID NOT NULL,
    "queryText"     TEXT NOT NULL,
    "raisedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt"   TIMESTAMP(3),
    "responseText"  TEXT,
    "correlationId" TEXT,

    CONSTRAINT "preauth_query_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "preauth_query_tenantId_claimId_raisedAt_idx"
  ON "preauth_query"("tenantId", "claimId", "raisedAt");

-- =====================================================
-- RLS — same shape as the rest of Sprint 2's tables.
-- =====================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      "preauth_draft", "preauth_query" TO claims_app;
  END IF;
END
$$;

-- preauth_draft
ALTER TABLE "preauth_draft" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "preauth_draft" FORCE ROW LEVEL SECURITY;

CREATE POLICY preauth_draft_select ON "preauth_draft"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY preauth_draft_insert ON "preauth_draft"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY preauth_draft_update ON "preauth_draft"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY preauth_draft_delete ON "preauth_draft"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

-- preauth_query
ALTER TABLE "preauth_query" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "preauth_query" FORCE ROW LEVEL SECURITY;

CREATE POLICY preauth_query_select ON "preauth_query"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY preauth_query_insert ON "preauth_query"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY preauth_query_update ON "preauth_query"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY preauth_query_delete ON "preauth_query"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
