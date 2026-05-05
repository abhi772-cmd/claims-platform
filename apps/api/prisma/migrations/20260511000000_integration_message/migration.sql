-- Slice K — integration_message ledger.

-- CreateTable
CREATE TABLE "integration_message" (
    "id"             UUID NOT NULL,
    "tenantId"       UUID NOT NULL,
    "claimId"        UUID,
    "direction"      TEXT NOT NULL,
    "integration"    TEXT NOT NULL,
    "operation"      TEXT NOT NULL,
    "correlationId"  TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "status"         TEXT NOT NULL DEFAULT 'pending',
    "failureClass"   TEXT,
    "retryCount"     INTEGER NOT NULL DEFAULT 0,
    "rawRequest"     JSONB,
    "rawResponse"    JSONB,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"    TIMESTAMP(3),
    "lastAttemptAt"  TIMESTAMP(3),

    CONSTRAINT "integration_message_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "integration_message_tenant_int_status_idx"
  ON "integration_message"("tenantId", "integration", "status", "createdAt");
CREATE INDEX "integration_message_correlationId_idx"
  ON "integration_message"("correlationId");
CREATE INDEX "integration_message_claimId_idx"
  ON "integration_message"("claimId");

-- =====================================================
-- RLS — same shape as the rest of the schema.
-- We allow UPDATE because the orchestrator flips status / failureClass
-- / retryCount on outbound rows. Tests + Sprint 3 will add a CHECK
-- constraint that rawRequest + rawResponse are immutable post-write.
-- =====================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "integration_message" TO claims_app;
  END IF;
END
$$;

ALTER TABLE "integration_message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_message" FORCE ROW LEVEL SECURITY;

CREATE POLICY integration_message_select ON "integration_message"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY integration_message_insert ON "integration_message"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY integration_message_update ON "integration_message"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY integration_message_delete ON "integration_message"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
