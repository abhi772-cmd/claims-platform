-- Slice R — encrypted patient PII.
-- Creates the Patient table with AES-256-GCM ciphertext columns +
-- exact-match lookup hashes; adds patientId FK on Case (nullable so
-- legacy cases without a Patient row remain valid).

-- =====================================================
-- patient
-- =====================================================
CREATE TABLE "patient" (
    "id"                      UUID NOT NULL,
    "tenantId"                UUID NOT NULL,
    "fullName"                TEXT NOT NULL,
    "dateOfBirth"             DATE,
    "gender"                  TEXT,
    "aadhaarCipher"           TEXT,
    "aadhaarKeyVersion"       TEXT,
    "abhaIdCipher"            TEXT,
    "abhaIdKeyVersion"        TEXT,
    "policyNumberCipher"      TEXT,
    "policyNumberKeyVersion"  TEXT,
    "mobileCipher"            TEXT,
    "mobileKeyVersion"        TEXT,
    "emailCipher"             TEXT,
    "emailKeyVersion"         TEXT,
    "aadhaarHash"             CHAR(64),
    "mobileHash"              CHAR(64),
    "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"               TIMESTAMP(3) NOT NULL,

    CONSTRAINT "patient_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "patient_tenantId_idx" ON "patient"("tenantId");
CREATE INDEX "patient_tenantId_aadhaarHash_idx"
  ON "patient"("tenantId", "aadhaarHash");
CREATE INDEX "patient_tenantId_mobileHash_idx"
  ON "patient"("tenantId", "mobileHash");

-- =====================================================
-- case.patientId FK (nullable for legacy rows)
-- =====================================================
ALTER TABLE "case" ADD COLUMN "patientId" UUID;
ALTER TABLE "case"
  ADD CONSTRAINT "case_patientId_fkey"
  FOREIGN KEY ("patientId") REFERENCES "patient"("id")
  ON DELETE SET NULL;
CREATE INDEX "case_patientId_idx" ON "case"("patientId");

-- =====================================================
-- Grants + RLS
-- =====================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "patient" TO claims_app;
  END IF;
END
$$;

ALTER TABLE "patient" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient" FORCE ROW LEVEL SECURITY;

CREATE POLICY patient_select ON "patient"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY patient_insert ON "patient"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY patient_update ON "patient"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY patient_delete ON "patient"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
