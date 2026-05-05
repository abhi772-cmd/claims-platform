-- Slice E — sessions, IP allowlist, trusted devices.
-- Adds:
--   * tenant.ipAllowlist (jsonb array of CIDR strings, default [])
--   * session.lastSeenAt
--   * trusted_device table (with RLS)

-- AlterTable
ALTER TABLE "tenant"
  ADD COLUMN "ipAllowlist" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "session"
  ADD COLUMN "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "trusted_device" (
    "id"            UUID NOT NULL,
    "tenantId"      UUID NOT NULL,
    "userId"        UUID NOT NULL,
    "tokenHash"     TEXT NOT NULL,
    "uaFingerprint" TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt"    TIMESTAMP(3),
    "expiresAt"     TIMESTAMP(3) NOT NULL,
    "revokedAt"     TIMESTAMP(3),
    "ipAddress"     TEXT,
    "userAgent"     TEXT,

    CONSTRAINT "trusted_device_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "trusted_device_tokenHash_key"
  ON "trusted_device"("tokenHash");
CREATE INDEX "trusted_device_tenantId_userId_idx"
  ON "trusted_device"("tenantId", "userId");
CREATE INDEX "trusted_device_expiresAt_idx"
  ON "trusted_device"("expiresAt");

-- AddForeignKey
ALTER TABLE "trusted_device" ADD CONSTRAINT "trusted_device_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================
-- RLS
-- =====================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      "trusted_device" TO claims_app;
  END IF;
END
$$;

ALTER TABLE "trusted_device" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "trusted_device" FORCE ROW LEVEL SECURITY;

CREATE POLICY trusted_device_select ON "trusted_device"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY trusted_device_insert ON "trusted_device"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY trusted_device_update ON "trusted_device"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY trusted_device_delete ON "trusted_device"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
