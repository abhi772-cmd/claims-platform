-- Slice CN — tenant ↔ payer empanelment join table.
--
-- The `payer` table is a platform-curated registry (superadmin owns
-- it). This table records which registry payers each tenant is tied
-- up with. Case-creation dropdowns + commercial terms read this, not
-- the whole registry.
--
-- RLS: same-tenant SELECT/INSERT/UPDATE; DELETE blocked (retire via
-- active=false so empanelment history survives). payer FK is global
-- (payer has no tenantId) so we don't cascade from tenant deletes
-- into the shared registry.

CREATE TABLE "tenant_payer" (
    "id"           UUID NOT NULL,
    "tenantId"     UUID NOT NULL,
    "payerId"      UUID NOT NULL,
    "active"       BOOLEAN NOT NULL DEFAULT true,
    "empanelledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_payer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_payer_tenantId_payerId_key"
  ON "tenant_payer"("tenantId", "payerId");
CREATE INDEX "tenant_payer_tenantId_active_idx"
  ON "tenant_payer"("tenantId", "active");

ALTER TABLE "tenant_payer"
  ADD CONSTRAINT "tenant_payer_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE;

ALTER TABLE "tenant_payer"
  ADD CONSTRAINT "tenant_payer_payerId_fkey"
  FOREIGN KEY ("payerId") REFERENCES "payer"("id") ON DELETE CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "tenant_payer" TO claims_app;
  END IF;
END
$$;

ALTER TABLE "tenant_payer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_payer" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_payer_select ON "tenant_payer"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY tenant_payer_insert ON "tenant_payer"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY tenant_payer_update ON "tenant_payer"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY tenant_payer_no_delete ON "tenant_payer"
  FOR DELETE USING (false);
