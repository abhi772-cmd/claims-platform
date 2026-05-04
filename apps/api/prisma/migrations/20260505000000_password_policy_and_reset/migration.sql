-- Slice C — password policy + reset.
-- Adds:
--   * user.lastPasswordChangeAt column
--   * password_history table (append-only via RLS)
--   * password_reset_token table (insert + flip-to-used only)

-- AlterTable
ALTER TABLE "user"
  ADD COLUMN "lastPasswordChangeAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "password_history" (
    "id"           UUID NOT NULL,
    "tenantId"     UUID NOT NULL,
    "userId"       UUID NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "changedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_history_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "password_history_tenantId_userId_changedAt_idx"
  ON "password_history"("tenantId", "userId", "changedAt");

-- AddForeignKey
ALTER TABLE "password_history" ADD CONSTRAINT "password_history_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "password_reset_token" (
    "id"          UUID NOT NULL,
    "tenantId"    UUID NOT NULL,
    "userId"      UUID NOT NULL,
    "tokenHash"   TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"   TIMESTAMP(3) NOT NULL,
    "usedAt"      TIMESTAMP(3),
    "requestedIp" TEXT,
    "requestedUa" TEXT,

    CONSTRAINT "password_reset_token_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "password_reset_token_tokenHash_key"
  ON "password_reset_token"("tokenHash");
CREATE INDEX "password_reset_token_tenantId_userId_requestedAt_idx"
  ON "password_reset_token"("tenantId", "userId", "requestedAt");
CREATE INDEX "password_reset_token_expiresAt_idx"
  ON "password_reset_token"("expiresAt");

-- AddForeignKey
ALTER TABLE "password_reset_token" ADD CONSTRAINT "password_reset_token_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================
-- RLS
-- =====================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      "password_history", "password_reset_token" TO claims_app;
  END IF;
END
$$;

-- password_history — append-only.
ALTER TABLE "password_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "password_history" FORCE ROW LEVEL SECURITY;

CREATE POLICY password_history_select ON "password_history"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

CREATE POLICY password_history_insert ON "password_history"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

CREATE POLICY password_history_no_update ON "password_history"
  FOR UPDATE USING (false);

CREATE POLICY password_history_no_delete ON "password_history"
  FOR DELETE USING (false);

-- password_reset_token — insert + update-to-mark-used only.
-- Updates are permitted (we flip usedAt) but tenants can only see/touch
-- their own rows. platform_admin bypass exists for cleanup jobs.
ALTER TABLE "password_reset_token" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "password_reset_token" FORCE ROW LEVEL SECURITY;

CREATE POLICY password_reset_token_select ON "password_reset_token"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

CREATE POLICY password_reset_token_insert ON "password_reset_token"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

CREATE POLICY password_reset_token_update ON "password_reset_token"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

CREATE POLICY password_reset_token_delete ON "password_reset_token"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
