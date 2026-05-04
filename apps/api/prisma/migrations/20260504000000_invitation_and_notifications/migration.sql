-- Slice B — invitation flow + notification outbox.
-- Schema additions plus RLS on the new tables.

-- AlterTable
ALTER TABLE "user"
  ADD COLUMN "inviteTokenHash"      TEXT,
  ADD COLUMN "inviteTokenExpiresAt" TIMESTAMP(3),
  ADD COLUMN "inviteAcceptedAt"     TIMESTAMP(3),
  ADD COLUMN "invitedById"          UUID;

-- CreateIndex
CREATE UNIQUE INDEX "user_inviteTokenHash_key" ON "user"("inviteTokenHash");
CREATE INDEX "user_inviteTokenExpiresAt_idx" ON "user"("inviteTokenExpiresAt");

-- CreateTable
CREATE TABLE "invite_resend" (
    "id"        UUID NOT NULL,
    "tenantId"  UUID NOT NULL,
    "userId"    UUID NOT NULL,
    "resentBy"  UUID NOT NULL,
    "resentAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invite_resend_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "invite_resend_tenantId_userId_resentAt_idx"
  ON "invite_resend"("tenantId", "userId", "resentAt");

-- AddForeignKey
ALTER TABLE "invite_resend" ADD CONSTRAINT "invite_resend_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "notification_outbox" (
    "id"          UUID NOT NULL,
    "tenantId"    UUID NOT NULL,
    "channel"     TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "recipient"   TEXT NOT NULL,
    "payload"     JSONB NOT NULL,
    "status"      TEXT NOT NULL DEFAULT 'queued',
    "attempts"    INTEGER NOT NULL DEFAULT 0,
    "lastError"   TEXT,
    "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt"      TIMESTAMP(3),

    CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "notification_outbox_tenantId_status_scheduledAt_idx"
  ON "notification_outbox"("tenantId", "status", "scheduledAt");
CREATE INDEX "notification_outbox_tenantId_recipient_idx"
  ON "notification_outbox"("tenantId", "recipient");

-- =====================================================
-- RLS for new tables. Same shape as Slice A: ENABLE+FORCE,
-- tenant-id GUC enforcement, platform_admin bypass.
-- =====================================================

-- Grants for runtime role
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      "invite_resend", "notification_outbox" TO claims_app;
  END IF;
END
$$;

-- invite_resend
ALTER TABLE "invite_resend" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invite_resend" FORCE ROW LEVEL SECURITY;

CREATE POLICY invite_resend_select ON "invite_resend"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

CREATE POLICY invite_resend_insert ON "invite_resend"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

CREATE POLICY invite_resend_no_update ON "invite_resend"
  FOR UPDATE USING (false);

CREATE POLICY invite_resend_no_delete ON "invite_resend"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

-- notification_outbox
ALTER TABLE "notification_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_outbox" FORCE ROW LEVEL SECURITY;

CREATE POLICY notification_outbox_select ON "notification_outbox"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

CREATE POLICY notification_outbox_insert ON "notification_outbox"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

CREATE POLICY notification_outbox_update ON "notification_outbox"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

CREATE POLICY notification_outbox_delete ON "notification_outbox"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
