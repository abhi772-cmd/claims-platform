-- Slice AH — appeal lifecycle.
-- Created when an operator starts an appeal against a rejected
-- preauth, rejected claim, or short-paid settlement. Three lifecycle
-- phases (initiated / submitted / resolved) tracked via the status
-- column; resolution captures the payer's decision so settlement
-- can pick up payment.expected (favourable) or claim.written_off
-- (unfavourable) afterward.

CREATE TABLE "appeal" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "supportingDocuments" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'initiated',
    "resolutionKind" TEXT,
    "resolutionNote" TEXT,
    "approvedAmount" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "startedByUserId" UUID,

    CONSTRAINT "appeal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "appeal_tenantId_claimId_startedAt_idx"
  ON "appeal"("tenantId", "claimId", "startedAt");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "appeal" TO claims_app;
  END IF;
END
$$;

ALTER TABLE "appeal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appeal" FORCE ROW LEVEL SECURITY;

CREATE POLICY appeal_select ON "appeal"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY appeal_insert ON "appeal"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY appeal_update ON "appeal"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY appeal_delete ON "appeal"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
