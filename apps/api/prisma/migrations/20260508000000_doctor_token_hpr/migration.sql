-- Slice F — doctor short-token + HPR stub.

-- CreateTable
CREATE TABLE "doctor_token" (
    "id"             UUID NOT NULL,
    "tenantId"       UUID NOT NULL,
    "doctorUserId"   UUID NOT NULL,
    "createdById"    UUID NOT NULL,
    "scope"          TEXT NOT NULL,
    "caseRef"        TEXT NOT NULL,
    "patientName"    TEXT NOT NULL,
    "tokenHash"      TEXT NOT NULL,
    "expiresAt"      TIMESTAMP(3) NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt"         TIMESTAMP(3),
    "signedHprId"    TEXT,
    "signedFullName" TEXT,
    "signatureNote"  TEXT,
    "ipAddress"      TEXT,
    "userAgent"      TEXT,

    CONSTRAINT "doctor_token_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "doctor_token_tokenHash_key" ON "doctor_token"("tokenHash");
CREATE INDEX "doctor_token_tenantId_doctorUserId_idx"
  ON "doctor_token"("tenantId", "doctorUserId");
CREATE INDEX "doctor_token_expiresAt_idx" ON "doctor_token"("expiresAt");

-- AddForeignKey
ALTER TABLE "doctor_token" ADD CONSTRAINT "doctor_token_doctorUserId_fkey"
  FOREIGN KEY ("doctorUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "doctor_token" ADD CONSTRAINT "doctor_token_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================
-- RLS
-- =====================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "doctor_token" TO claims_app;
  END IF;
END
$$;

ALTER TABLE "doctor_token" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "doctor_token" FORCE ROW LEVEL SECURITY;

CREATE POLICY doctor_token_select ON "doctor_token"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY doctor_token_insert ON "doctor_token"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY doctor_token_update ON "doctor_token"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY doctor_token_delete ON "doctor_token"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
