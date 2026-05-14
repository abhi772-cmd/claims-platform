-- Slice ON-2 of the onboarding spec diff (docs/15) — KYC document
-- upload table. Tenants upload the 6 KYC artefacts required by Stage
-- 3 of the onboarding flow (hospital registration, ROHINI, GST, PAN,
-- signatory ID, cancelled cheque). Each row goes through:
--   uploading      — init created the row; client is PUT-ing bytes
--   pending_review — finalize observed the bytes; awaiting ops
--   (slice ON-3)   approved | rejected | resubmission_requested
--
-- Bytes never flow through the API server — we presign PUT/GET URLs
-- against the configured StorageAdapter (S3 / OVH Object Storage in
-- prod, stub in tests). Same split-of-concerns as the existing
-- `document` table (slice M).

CREATE TYPE "KycDocumentType" AS ENUM (
  'hospital_registration',
  'rohini_registration',
  'gst_certificate',
  'pan',
  'signatory_id',
  'cancelled_cheque',
  'dpa_signed',
  'msa_signed'
);

CREATE TYPE "KycDocumentStatus" AS ENUM (
  'uploading',
  'pending_review',
  'approved',
  'rejected',
  'resubmission_requested'
);

CREATE TABLE "kyc_document" (
    "id"                   UUID NOT NULL,
    "tenantId"             UUID NOT NULL,
    "documentType"         "KycDocumentType" NOT NULL,
    "status"               "KycDocumentStatus" NOT NULL DEFAULT 'uploading',
    "storageBucket"        TEXT,
    "storageKey"           TEXT,
    "originalFilename"     TEXT NOT NULL,
    "contentType"          TEXT NOT NULL,
    "declaredSizeBytes"    INTEGER NOT NULL,
    "actualSizeBytes"      INTEGER,
    "sha256"               CHAR(64),
    "etag"                 TEXT,
    "uploadedByUserId"     UUID NOT NULL,
    "uploadedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizedAt"          TIMESTAMP(3),
    -- Review fields populated in slice ON-3 (ops review queue). Kept
    -- in this migration so the row shape is stable across slices.
    "reviewedByUserId"     UUID,
    "reviewedAt"           TIMESTAMP(3),
    "reviewNotes"          TEXT,
    "rejectionReasonCode"  TEXT,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kyc_document_pkey" PRIMARY KEY ("id")
);

-- One row per (tenant, documentType) is the common case in the UI
-- (the checklist). We don't make it unique at the DB level — when
-- ops requests resubmission, the old row stays for audit and a new
-- row is inserted. The service-layer picks the most recent
-- non-rejected row per type when computing step completion.
CREATE INDEX "kyc_document_tenant_type_idx"
  ON "kyc_document"("tenantId", "documentType");
CREATE INDEX "kyc_document_tenant_status_idx"
  ON "kyc_document"("tenantId", "status");
-- Ops queue (slice ON-3): list pending_review across tenants, oldest
-- first. The index is shared with the per-tenant view because the
-- queue's first column is status.
CREATE INDEX "kyc_document_status_uploaded_idx"
  ON "kyc_document"("status", "uploadedAt");

ALTER TABLE "kyc_document" ADD CONSTRAINT "kyc_document_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================
-- RLS
-- =====================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "kyc_document" TO claims_app;
  END IF;
END
$$;

ALTER TABLE "kyc_document" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "kyc_document" FORCE ROW LEVEL SECURITY;

-- Tenant sees its own rows; platform_admin sees all (for the ops
-- review queue in slice ON-3).
CREATE POLICY kyc_document_select ON "kyc_document"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY kyc_document_insert ON "kyc_document"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
-- UPDATE is allowed for both:
--  * tenant — service uses it to finalize (uploading → pending_review).
--  * platform_admin — slice ON-3 will use it to set reviewStatus.
-- Field-level restriction (tenant can't touch reviewStatus etc.) is
-- enforced at the service layer; RLS handles tenant isolation only.
CREATE POLICY kyc_document_update ON "kyc_document"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
-- Tenant can delete its own rows; service refuses if status is past
-- pending_review. Platform admin can delete (used by the GDPR /
-- DPDP erasure pipeline in slice BQ).
CREATE POLICY kyc_document_delete ON "kyc_document"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
