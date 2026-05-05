-- Slice N — settlement (one row per claim).

-- CreateTable
CREATE TABLE "settlement" (
    "id"                   UUID NOT NULL,
    "tenantId"             UUID NOT NULL,
    "claimId"              UUID NOT NULL,
    "paymentMode"          TEXT NOT NULL,
    "expectedAmount"       INTEGER NOT NULL,
    "receivedAmount"       INTEGER,
    "deductionAmount"      INTEGER,
    "deductions"           JSONB NOT NULL DEFAULT '[]',
    "shortPaymentReasons"  JSONB NOT NULL DEFAULT '[]',
    "receivedAt"           TIMESTAMP(3),
    "eobDocumentId"        UUID,
    "reconciliationStatus" TEXT NOT NULL DEFAULT 'manual_match_pending',
    "closedAt"             TIMESTAMP(3),
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlement_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "settlement_claimId_key" ON "settlement"("claimId");
CREATE INDEX "settlement_tenantId_claimId_idx"
  ON "settlement"("tenantId", "claimId");
CREATE INDEX "settlement_tenantId_reconciliationStatus_idx"
  ON "settlement"("tenantId", "reconciliationStatus");

-- =====================================================
-- RLS
-- =====================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "settlement" TO claims_app;
  END IF;
END
$$;

ALTER TABLE "settlement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settlement" FORCE ROW LEVEL SECURITY;

CREATE POLICY settlement_select ON "settlement"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY settlement_insert ON "settlement"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY settlement_update ON "settlement"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY settlement_delete ON "settlement"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
