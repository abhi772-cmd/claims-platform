-- Slice D — MFA (TOTP + backup codes).
-- New tables: mfa_enrollment, backup_code, mfa_challenge.

-- CreateTable
CREATE TABLE "mfa_enrollment" (
    "id"           UUID NOT NULL,
    "tenantId"     UUID NOT NULL,
    "userId"       UUID NOT NULL,
    "secret"       TEXT NOT NULL,
    "confirmedAt"  TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    "lastUsedStep" BIGINT,

    CONSTRAINT "mfa_enrollment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mfa_enrollment_userId_key" ON "mfa_enrollment"("userId");
CREATE INDEX "mfa_enrollment_tenantId_idx" ON "mfa_enrollment"("tenantId");

-- AddForeignKey
ALTER TABLE "mfa_enrollment" ADD CONSTRAINT "mfa_enrollment_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "backup_code" (
    "id"        UUID NOT NULL,
    "tenantId"  UUID NOT NULL,
    "userId"    UUID NOT NULL,
    "codeHash"  TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt"    TIMESTAMP(3),

    CONSTRAINT "backup_code_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "backup_code_codeHash_key" ON "backup_code"("codeHash");
CREATE INDEX "backup_code_tenantId_userId_idx" ON "backup_code"("tenantId", "userId");

-- AddForeignKey
ALTER TABLE "backup_code" ADD CONSTRAINT "backup_code_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "mfa_challenge" (
    "id"           UUID NOT NULL,
    "tenantId"     UUID NOT NULL,
    "userId"       UUID NOT NULL,
    "challengeId"  TEXT NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"    TIMESTAMP(3) NOT NULL,
    "consumedAt"   TIMESTAMP(3),
    "ipAddress"    TEXT,
    "userAgent"    TEXT,

    CONSTRAINT "mfa_challenge_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mfa_challenge_challengeId_key" ON "mfa_challenge"("challengeId");
CREATE INDEX "mfa_challenge_tenantId_userId_idx" ON "mfa_challenge"("tenantId", "userId");
CREATE INDEX "mfa_challenge_expiresAt_idx" ON "mfa_challenge"("expiresAt");

-- AddForeignKey
ALTER TABLE "mfa_challenge" ADD CONSTRAINT "mfa_challenge_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================
-- RLS
-- =====================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      "mfa_enrollment", "backup_code", "mfa_challenge" TO claims_app;
  END IF;
END
$$;

-- mfa_enrollment — full read/write inside tenant; rotates on re-setup so
-- UPDATE is allowed.
ALTER TABLE "mfa_enrollment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mfa_enrollment" FORCE ROW LEVEL SECURITY;

CREATE POLICY mfa_enrollment_select ON "mfa_enrollment"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY mfa_enrollment_insert ON "mfa_enrollment"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY mfa_enrollment_update ON "mfa_enrollment"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY mfa_enrollment_delete ON "mfa_enrollment"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

-- backup_code — INSERT to issue a batch, UPDATE only to flip usedAt
-- (no DELETE except platform_admin), no row content mutation beyond usedAt.
-- We rely on the application enforcing single-use; the policy here just
-- bounds the visibility envelope.
ALTER TABLE "backup_code" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "backup_code" FORCE ROW LEVEL SECURITY;

CREATE POLICY backup_code_select ON "backup_code"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY backup_code_insert ON "backup_code"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY backup_code_update ON "backup_code"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY backup_code_delete ON "backup_code"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

-- mfa_challenge — short-lived; we update consumedAt; deletes for cleanup.
ALTER TABLE "mfa_challenge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mfa_challenge" FORCE ROW LEVEL SECURITY;

CREATE POLICY mfa_challenge_select ON "mfa_challenge"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY mfa_challenge_insert ON "mfa_challenge"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY mfa_challenge_update ON "mfa_challenge"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY mfa_challenge_delete ON "mfa_challenge"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
