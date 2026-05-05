-- Slice I — claim aggregate (event-sourced).
--   * "case" — container for one or more claims.
--   * "claim" — materialised state.
--   * "claim_event" — append-only log of truth (RLS denies UPDATE / DELETE).
-- HTTP CRUD lands in a later slice; this slice ships the engine only.

-- CreateTable: case
CREATE TABLE "case" (
    "id"               UUID NOT NULL,
    "tenantId"         UUID NOT NULL,
    "patientName"      TEXT NOT NULL,
    "hospitalMrn"      TEXT NOT NULL,
    "admissionDate"    DATE NOT NULL,
    "admissionType"    TEXT NOT NULL,
    "primaryRail"      TEXT NOT NULL,
    "caseStatus"       TEXT NOT NULL DEFAULT 'open',
    "treatingDoctorId" UUID,
    "createdById"      UUID NOT NULL,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,
    "closedAt"         TIMESTAMP(3),

    CONSTRAINT "case_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "case_tenantId_caseStatus_idx" ON "case"("tenantId", "caseStatus");
CREATE INDEX "case_tenantId_hospitalMrn_idx" ON "case"("tenantId", "hospitalMrn");

-- CreateTable: claim
CREATE TABLE "claim" (
    "id"               UUID NOT NULL,
    "tenantId"         UUID NOT NULL,
    "caseId"           UUID NOT NULL,
    "rail"             TEXT NOT NULL,
    "status"           TEXT NOT NULL,
    "preauthAmount"    INTEGER,
    "claimAmount"      INTEGER,
    "approvedAmount"   INTEGER,
    "paidAmount"       INTEGER,
    "preauthRefNum"    TEXT,
    "claimRefNum"      TEXT,
    "payerRefNum"      TEXT,
    "assignedToUserId" UUID,
    "initiatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt"      TIMESTAMP(3),
    "approvedAt"       TIMESTAMP(3),
    "paidAt"           TIMESTAMP(3),
    "closedAt"         TIMESTAMP(3),

    CONSTRAINT "claim_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "claim_tenantId_status_idx" ON "claim"("tenantId", "status");
CREATE INDEX "claim_tenantId_assignedToUserId_status_idx"
  ON "claim"("tenantId", "assignedToUserId", "status");
CREATE INDEX "claim_caseId_idx" ON "claim"("caseId");

-- AddForeignKey: claim.caseId → case.id
ALTER TABLE "claim" ADD CONSTRAINT "claim_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: claim_event (append-only)
CREATE TABLE "claim_event" (
    "id"              UUID NOT NULL,
    "tenantId"        UUID NOT NULL,
    "claimId"         UUID NOT NULL,
    "eventType"       TEXT NOT NULL,
    "resultingStatus" TEXT NOT NULL,
    "occurredAt"      TIMESTAMP(3) NOT NULL,
    "recordedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById"    UUID,
    "payload"         JSONB NOT NULL DEFAULT '{}',
    "correlationId"   TEXT,
    "prevEventId"     UUID,

    CONSTRAINT "claim_event_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "claim_event_claimId_occurredAt_idx"
  ON "claim_event"("claimId", "occurredAt");
CREATE INDEX "claim_event_tenantId_eventType_idx"
  ON "claim_event"("tenantId", "eventType");

-- AddForeignKey: claim_event.claimId → claim.id
ALTER TABLE "claim_event" ADD CONSTRAINT "claim_event_claimId_fkey"
  FOREIGN KEY ("claimId") REFERENCES "claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================
-- RLS — same shape as Slice A: tenant scope + platform_admin bypass.
-- claim_event is append-only (USING(false) on UPDATE/DELETE).
-- =====================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      "case", "claim", "claim_event" TO claims_app;
  END IF;
END
$$;

-- case
ALTER TABLE "case" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "case" FORCE ROW LEVEL SECURITY;

CREATE POLICY case_select ON "case"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY case_insert ON "case"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY case_update ON "case"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY case_delete ON "case"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

-- claim
ALTER TABLE "claim" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "claim" FORCE ROW LEVEL SECURITY;

CREATE POLICY claim_select ON "claim"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY claim_insert ON "claim"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY claim_update ON "claim"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY claim_delete ON "claim"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

-- claim_event — append-only.
ALTER TABLE "claim_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "claim_event" FORCE ROW LEVEL SECURITY;

CREATE POLICY claim_event_select ON "claim_event"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY claim_event_insert ON "claim_event"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY claim_event_no_update ON "claim_event"
  FOR UPDATE USING (false);
CREATE POLICY claim_event_no_delete ON "claim_event"
  FOR DELETE USING (false);
