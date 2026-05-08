-- Slice BR — DPDP §17 data access ledger.
--
-- Append-only at the RLS level — no UPDATE / DELETE permitted from
-- the runtime role. Reads are platform_admin OR tenant-match. The
-- table is structurally similar to audit_log but semantically
-- distinct: audit_log records state changes ("what changed"),
-- this records reads ("who saw what, why").
--
-- Retention: governed by audit_log's retention class system in BO/BP
-- via mirror columns when BU dashboard ships; for BR this table
-- isn't on the sweeper's path. Ops can extend the sweeper later
-- with `data_access_event` as a separate class.

CREATE TABLE "data_access_event" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" UUID,
    "actorType" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "action" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "fieldNames" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "correlationId" TEXT,

    CONSTRAINT "data_access_event_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "data_access_event_tenantId_occurredAt_idx"
  ON "data_access_event"("tenantId", "occurredAt");
CREATE INDEX "data_access_event_tenantId_resourceType_resourceId_idx"
  ON "data_access_event"("tenantId", "resourceType", "resourceId");
CREATE INDEX "data_access_event_tenantId_actorUserId_idx"
  ON "data_access_event"("tenantId", "actorUserId");

ALTER TABLE "data_access_event"
  ADD CONSTRAINT "data_access_event_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "data_access_event" TO claims_app;
  END IF;
END
$$;

ALTER TABLE "data_access_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "data_access_event" FORCE ROW LEVEL SECURITY;

CREATE POLICY data_access_event_select ON "data_access_event"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY data_access_event_insert ON "data_access_event"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
-- Append-only — the access ledger is itself a compliance artifact.
-- Edits / deletions would defeat the audit story.
CREATE POLICY data_access_event_no_update ON "data_access_event"
  FOR UPDATE USING (false);
CREATE POLICY data_access_event_no_delete ON "data_access_event"
  FOR DELETE USING (false);
