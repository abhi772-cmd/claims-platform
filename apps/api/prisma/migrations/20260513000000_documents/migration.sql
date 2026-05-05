-- Slice M — documents (file metadata only; binaries land in S3 in Slice P).

-- CreateTable
CREATE TABLE "document" (
    "id"               UUID NOT NULL,
    "tenantId"         UUID NOT NULL,
    "claimId"          UUID NOT NULL,
    "documentType"     TEXT NOT NULL,
    "storageBucket"    TEXT NOT NULL,
    "storageKey"       TEXT NOT NULL,
    "etag"             TEXT,
    "contentType"      TEXT NOT NULL,
    "sizeBytes"        INTEGER NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "uploadedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedById"     UUID,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "document_tenantId_claimId_idx" ON "document"("tenantId", "claimId");
CREATE INDEX "document_claimId_documentType_idx" ON "document"("claimId", "documentType");

-- =====================================================
-- RLS
-- =====================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "document" TO claims_app;
  END IF;
END
$$;

ALTER TABLE "document" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document" FORCE ROW LEVEL SECURITY;

CREATE POLICY document_select ON "document"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY document_insert ON "document"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY document_update ON "document"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY document_delete ON "document"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
