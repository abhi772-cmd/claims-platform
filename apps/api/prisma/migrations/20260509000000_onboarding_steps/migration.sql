-- Slice G — onboarding wizard + readiness check + lifecycle transitions.
-- The lifecycle FSM lives in code (TenantLifecycleService); only the
-- onboarding_step table is new here.

-- CreateTable
CREATE TABLE "onboarding_step" (
    "id"          UUID NOT NULL,
    "tenantId"    UUID NOT NULL,
    "stepKey"     TEXT NOT NULL,
    "status"      TEXT NOT NULL,
    "evidence"    JSONB NOT NULL DEFAULT '{}',
    "completedAt" TIMESTAMP(3),
    "completedBy" UUID,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboarding_step_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "onboarding_step_tenantId_stepKey_key"
  ON "onboarding_step"("tenantId", "stepKey");
CREATE INDEX "onboarding_step_tenantId_idx" ON "onboarding_step"("tenantId");

-- AddForeignKey
ALTER TABLE "onboarding_step" ADD CONSTRAINT "onboarding_step_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================
-- RLS
-- =====================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "onboarding_step" TO claims_app;
  END IF;
END
$$;

ALTER TABLE "onboarding_step" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "onboarding_step" FORCE ROW LEVEL SECURITY;

CREATE POLICY onboarding_step_select ON "onboarding_step"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY onboarding_step_insert ON "onboarding_step"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY onboarding_step_update ON "onboarding_step"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY onboarding_step_delete ON "onboarding_step"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
