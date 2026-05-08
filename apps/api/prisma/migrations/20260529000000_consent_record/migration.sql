-- Slice BT — DPDP Act 2023 §6 / Rule 8 consent record + access-ledger binding.
--
-- Two parts:
--   1. New consent_record table with same-tenant SELECT/INSERT/UPDATE
--      and DELETE blocked (consent records are compliance artifacts).
--   2. New nullable consentGrantId column on data_access_event so
--      reads can be bound back to the consent that authorised them.
--      Backfilled to null — pre-BT rows simply have no binding.

-- 1. consent_record ------------------------------------------------

CREATE TABLE "consent_record" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "consentType" TEXT NOT NULL,
    "dataCategories" JSONB NOT NULL,
    "purposes" JSONB NOT NULL,
    "lawfulBasis" TEXT NOT NULL DEFAULT 'consent',
    "status" TEXT NOT NULL DEFAULT 'granted',
    "source" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "withdrawalReason" TEXT,
    "capturedByUserId" UUID,
    "documentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consent_record_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "consent_record_tenantId_patientId_consentType_status_idx"
  ON "consent_record"("tenantId", "patientId", "consentType", "status");
CREATE INDEX "consent_record_tenantId_status_idx"
  ON "consent_record"("tenantId", "status");
CREATE INDEX "consent_record_tenantId_expiresAt_idx"
  ON "consent_record"("tenantId", "expiresAt");

ALTER TABLE "consent_record"
  ADD CONSTRAINT "consent_record_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE;

-- patientId FK with NO ACTION so a future BQ erasure doesn't accidentally
-- delete consent records — they outlast the redacted patient under
-- DPDP §6 audit obligations. The ErasureRequestService deliberately
-- does not delete patient rows; it scrubs the PII columns instead.
ALTER TABLE "consent_record"
  ADD CONSTRAINT "consent_record_patientId_fkey"
  FOREIGN KEY ("patientId") REFERENCES "patient"("id") ON DELETE NO ACTION;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "consent_record" TO claims_app;
  END IF;
END
$$;

ALTER TABLE "consent_record" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "consent_record" FORCE ROW LEVEL SECURITY;

CREATE POLICY consent_record_select ON "consent_record"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY consent_record_insert ON "consent_record"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
-- UPDATE allowed for tenant-scoped status flips (withdrawal). The
-- legal sequencing (granted → withdrawn / expired) is enforced by
-- the application; RLS just gates cross-tenant isolation.
CREATE POLICY consent_record_update ON "consent_record"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
-- DELETE blocked — consent records are themselves a compliance
-- artifact and must outlast the data they authorised. Withdraw
-- instead.
CREATE POLICY consent_record_no_delete ON "consent_record"
  FOR DELETE USING (false);


-- 2. data_access_event.consentGrantId ------------------------------

ALTER TABLE "data_access_event"
  ADD COLUMN "consentGrantId" UUID;

CREATE INDEX "data_access_event_tenantId_consentGrantId_idx"
  ON "data_access_event"("tenantId", "consentGrantId");

-- No FK to consent_record — the ledger row must outlive the consent
-- record's CASCADE behaviour if a future migration ever drops a
-- consent. We keep this loose-coupled by uuid; BU's dashboard joins
-- defensively (LEFT JOIN with a "consent withdrawn / no longer found"
-- badge for orphans).
