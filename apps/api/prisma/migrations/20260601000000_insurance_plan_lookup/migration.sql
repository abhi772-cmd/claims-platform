-- InsurancePlan lookup ledger (GAP_ANALYSIS.md row 1.14 follow-up).
--
-- Populated by InsurancePlanService.request when we POST
-- `insuranceplan/request` to NHA, and updated by the inbound
-- dispatcher's `insuranceplan/on_request` branch when the matching
-- callback lands.
--
-- The unique index on correlationId is what enables the dispatcher's
-- single-row update — the gateway echoes our correlation id back on
-- the callback, so a tenant-scoped UPDATE WHERE correlationId=... is
-- safe + deterministic.
--
-- All plan-detail columns are nullable: they're populated only by the
-- callback. A row sitting at status='pending' with NULL details is
-- the expected steady state while the payer is processing.

CREATE TABLE "insurance_plan_lookup" (
  "id"                UUID NOT NULL,
  "tenantId"          UUID NOT NULL,
  "claimId"           UUID,
  "correlationId"     TEXT NOT NULL,
  "payerCode"         TEXT NOT NULL,
  "policyNumber"      TEXT NOT NULL,
  "providerId"        TEXT NOT NULL,
  "requestedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "requestedByUserId" UUID,
  "status"            TEXT NOT NULL DEFAULT 'pending',
  "planId"            TEXT,
  "planName"          TEXT,
  "planStatus"        TEXT,
  "planType"          TEXT,
  "sumInsuredPaise"   INTEGER,
  "periodStart"       TEXT,
  "periodEnd"         TEXT,
  "network"           TEXT,
  "failureReason"     TEXT,
  "resolvedAt"        TIMESTAMP(3),

  CONSTRAINT "insurance_plan_lookup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "insurance_plan_lookup_correlationId_key"
  ON "insurance_plan_lookup" ("correlationId");
CREATE INDEX "insurance_plan_lookup_tenantId_claimId_idx"
  ON "insurance_plan_lookup" ("tenantId", "claimId");
CREATE INDEX "insurance_plan_lookup_tenantId_requestedAt_idx"
  ON "insurance_plan_lookup" ("tenantId", "requestedAt");

-- RLS — same shape as integration_message: tenant isolation for app,
-- platform_admin bypass for ops tooling.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "insurance_plan_lookup" TO claims_app;
  END IF;
END
$$;

ALTER TABLE "insurance_plan_lookup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "insurance_plan_lookup" FORCE ROW LEVEL SECURITY;

CREATE POLICY insurance_plan_lookup_select ON "insurance_plan_lookup"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY insurance_plan_lookup_insert ON "insurance_plan_lookup"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY insurance_plan_lookup_update ON "insurance_plan_lookup"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY insurance_plan_lookup_delete ON "insurance_plan_lookup"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
