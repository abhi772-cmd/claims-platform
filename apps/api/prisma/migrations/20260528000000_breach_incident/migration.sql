-- Slice BS — DPDP §8(6) breach incident record.
--
-- Per-tenant table holding both auto-detected and operator-filed
-- breach incidents. Status lifecycle is managed by the application;
-- RLS lets same-tenant callers read AND update (so the controller
-- can flip status to notified / dismissed). DELETE is blocked —
-- breach records are themselves a compliance artifact and shouldn't
-- vanish.
--
-- The unique constraint on (tenantId, kind, actorUserId, windowStart)
-- gives the detector idempotency: re-running scan() on the same
-- window won't create duplicate rows. Manual reports leave both
-- actorUserId and windowStart null and so naturally skip the unique
-- constraint (Postgres treats NULL ≠ NULL in unique constraints,
-- which is exactly what we want here — multiple manual reports per
-- tenant are allowed).

CREATE TABLE "breach_incident" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'detected',
    "actorUserId" UUID,
    "affectedDataPrincipals" INTEGER NOT NULL DEFAULT 0,
    "dataCategories" JSONB NOT NULL,
    "description" TEXT NOT NULL,
    "evidenceEventIds" JSONB NOT NULL,
    "windowStart" TIMESTAMP(3),
    "windowEnd" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dpdpNotificationDueAt" TIMESTAMP(3) NOT NULL,
    "dpdpNotificationSentAt" TIMESTAMP(3),
    "dpdpNotificationPayload" JSONB,
    "dismissalReason" TEXT,
    "processedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "breach_incident_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "breach_incident_tenantId_kind_actorUserId_windowStart_key"
  ON "breach_incident"("tenantId", "kind", "actorUserId", "windowStart");
CREATE INDEX "breach_incident_tenantId_openedAt_idx"
  ON "breach_incident"("tenantId", "openedAt");
CREATE INDEX "breach_incident_tenantId_status_idx"
  ON "breach_incident"("tenantId", "status");
CREATE INDEX "breach_incident_tenantId_kind_idx"
  ON "breach_incident"("tenantId", "kind");
CREATE INDEX "breach_incident_tenantId_dpdpNotificationDueAt_idx"
  ON "breach_incident"("tenantId", "dpdpNotificationDueAt");

ALTER TABLE "breach_incident"
  ADD CONSTRAINT "breach_incident_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "breach_incident" TO claims_app;
  END IF;
END
$$;

ALTER TABLE "breach_incident" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "breach_incident" FORCE ROW LEVEL SECURITY;

CREATE POLICY breach_incident_select ON "breach_incident"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY breach_incident_insert ON "breach_incident"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
-- UPDATE allowed for tenant-scoped status flips (notify / dismiss
-- / resolve). The application enforces the legal state-machine in
-- BreachIncidentService — RLS just guarantees cross-tenant isolation.
CREATE POLICY breach_incident_update ON "breach_incident"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
-- DELETE blocked — breach records are themselves a compliance
-- artifact. If a row is wrong, dismiss it instead.
CREATE POLICY breach_incident_no_delete ON "breach_incident"
  FOR DELETE USING (false);
