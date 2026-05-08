-- Slice BQ — DPDP Act 2023 §11 erasure-on-request log + RLS.
--
-- One row per request, tenant-scoped. Status is set at insert time
-- (v1 has no pending state); each row is either 'completed' or
-- 'rejected'. Append-only at the RLS level — no UPDATE policy means
-- updates are silently dropped. Admins build new rows for each
-- request; revisiting an old request creates a fresh row.
--
-- The actual PII redaction happens on the Patient + Case rows,
-- gated by ErasureRequestService. This table is the compliance
-- audit trail that lets us answer "show me every erasure request
-- this hospital received and how it was resolved".

CREATE TABLE "erasure_request" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID,
    "requestedBy" TEXT NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL,
    "rejectionReason" JSONB,
    "affectedCounts" JSONB,
    "processedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "erasure_request_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "erasure_request_tenantId_createdAt_idx"
  ON "erasure_request"("tenantId", "createdAt");
CREATE INDEX "erasure_request_tenantId_patientId_idx"
  ON "erasure_request"("tenantId", "patientId");

ALTER TABLE "erasure_request"
  ADD CONSTRAINT "erasure_request_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE;

-- patientId is intentionally NOT a foreign key — the patient row may
-- be redacted later (ironically, the row whose erasure this records
-- still exists with redacted fields, not deleted). We keep a soft
-- pointer for trace-back without coupling the lifecycle.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "erasure_request" TO claims_app;
  END IF;
END
$$;

ALTER TABLE "erasure_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "erasure_request" FORCE ROW LEVEL SECURITY;

CREATE POLICY erasure_request_select ON "erasure_request"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY erasure_request_insert ON "erasure_request"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
-- Append-only — audit-trail semantics. Once filed, a request row
-- isn't edited.
CREATE POLICY erasure_request_no_update ON "erasure_request"
  FOR UPDATE USING (false);
CREATE POLICY erasure_request_no_delete ON "erasure_request"
  FOR DELETE USING (false);
