-- Slice ON-4 of the onboarding spec diff (docs/15) — NHCX participant
-- onboarding state, persisted per tenant. One row per tenant holds the
-- HFR facility ID, NHA-issued participant code (`<id>@hcx`), the
-- callback URL we registered, role (always 'provider' for hospitals),
-- and the sandbox/production flag. Populated by ops via the
-- `/admin/tenants/:id/nhcx/register-participant` endpoint; that
-- endpoint also writes integration_message rows so the call to NHA
-- is fully auditable.

CREATE TABLE "tenant_nhcx_config" (
    "id"                    UUID NOT NULL,
    "tenantId"              UUID NOT NULL,
    "hfrFacilityId"         TEXT NOT NULL,
    -- Issued by NHA's participant registry; nullable until registration
    -- succeeds. Format: `<hospital-id>@hcx` (sandbox) or `<id>@hcx-prod`
    -- (production) — we don't enforce the suffix here because the
    -- value is opaque to the platform.
    "participantCode"       TEXT,
    -- Always 'provider' for hospitals today; the column carries it so
    -- the field-set matches NHA's API and we don't have to backfill
    -- when payer-side tenants become a thing in v2.
    "role"                  TEXT NOT NULL DEFAULT 'provider',
    -- The bridge URL we registered with NHA — gateway pushes inbound
    -- callbacks here. Namespaced per tenant
    -- (`<base>/callback/<tenantId>/on_request`) so the inbound
    -- dispatcher can fan out without route ambiguity.
    "callbackUrl"           TEXT NOT NULL,
    -- True = the row is registered against NHA's sandbox; false = real
    -- production gateway. Lifecycle gating: tenants in LIVE must have
    -- sandboxMode=false; we'll enforce that in the lifecycle FSM in a
    -- later slice.
    "sandboxMode"           BOOLEAN NOT NULL DEFAULT true,
    "registeredAt"          TIMESTAMP(3),
    "registeredByUserId"    UUID,
    -- Last error string from the most recent failed registration
    -- attempt, surfaced on the ops UI. Cleared on the next success.
    "lastError"             TEXT,
    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_nhcx_config_pkey" PRIMARY KEY ("id")
);
-- One row per tenant — the registration is a tenant-level identity.
CREATE UNIQUE INDEX "tenant_nhcx_config_tenantId_key"
  ON "tenant_nhcx_config"("tenantId");

ALTER TABLE "tenant_nhcx_config" ADD CONSTRAINT "tenant_nhcx_config_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================
-- RLS
-- =====================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "tenant_nhcx_config" TO claims_app;
  END IF;
END
$$;

ALTER TABLE "tenant_nhcx_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_nhcx_config" FORCE ROW LEVEL SECURITY;

-- Tenant can read its own row (the onboarding wizard surfaces the
-- registered participant code). Only platform_admin can write —
-- registration is an ops-on-behalf operation, not something the
-- hospital can self-serve.
CREATE POLICY tenant_nhcx_config_select ON "tenant_nhcx_config"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY tenant_nhcx_config_insert ON "tenant_nhcx_config"
  FOR INSERT WITH CHECK (app_current_role() = 'platform_admin');
CREATE POLICY tenant_nhcx_config_update ON "tenant_nhcx_config"
  FOR UPDATE
  USING (app_current_role() = 'platform_admin')
  WITH CHECK (app_current_role() = 'platform_admin');
CREATE POLICY tenant_nhcx_config_delete ON "tenant_nhcx_config"
  FOR DELETE USING (app_current_role() = 'platform_admin');
