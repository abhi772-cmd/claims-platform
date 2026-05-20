-- Slice CM — typed acknowledgement method + OTP-flow artifact table.
--
-- Two parts:
--   1. consent_record gains `acknowledgementMethod` (typed enum-as-text)
--      and `acknowledgementRef` (uuid → consent_otp / consent_verbal /
--      consent_abha_request). Both nullable for backward compat with
--      pre-CM rows.
--   2. New consent_otp table — append-only OTP issuance + verification
--      artifact. Used as the default consent capture path. Verbal and
--      ABHA artifact tables land in follow-up slices but the
--      acknowledgementRef column is shaped to point at any of them.
--
-- No new ConsentStatus enum value at the SQL level — status is TEXT,
-- application code accepts the new 'pending_countersign' value
-- (introduced for verbal_countersigned flow) without a column change.

-- 1. consent_record gets typed method + artifact ref columns ---------

ALTER TABLE "consent_record"
  ADD COLUMN "acknowledgementMethod" TEXT,
  ADD COLUMN "acknowledgementRef"    UUID;

CREATE INDEX "consent_record_tenantId_ackMethod_status_idx"
  ON "consent_record"("tenantId", "acknowledgementMethod", "status");


-- 2. consent_otp — OTP issuance + verification artifact --------------

CREATE TABLE "consent_otp" (
    "id"                UUID NOT NULL,
    "tenantId"          UUID NOT NULL,
    "patientId"         UUID NOT NULL,
    "consentType"       TEXT NOT NULL,
    "hashedOtp"         TEXT NOT NULL,
    "mobileLast4"       VARCHAR(4) NOT NULL,
    "gatewayMessageId"  TEXT,
    "noticeText"        TEXT NOT NULL,
    "locales"           JSONB NOT NULL DEFAULT '[]',
    "attempts"          INTEGER NOT NULL DEFAULT 0,
    "sentAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"         TIMESTAMP(3) NOT NULL,
    "verifiedAt"        TIMESTAMP(3),
    "status"            TEXT NOT NULL DEFAULT 'sent',
    "initiatedByUserId" UUID NOT NULL,
    "verifiedByUserId"  UUID,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consent_otp_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "consent_otp_tenantId_status_idx"
  ON "consent_otp"("tenantId", "status");
CREATE INDEX "consent_otp_tenantId_patientId_idx"
  ON "consent_otp"("tenantId", "patientId");
CREATE INDEX "consent_otp_tenantId_expiresAt_idx"
  ON "consent_otp"("tenantId", "expiresAt");

ALTER TABLE "consent_otp"
  ADD CONSTRAINT "consent_otp_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE;

-- Same rationale as consent_record: the OTP artifact must outlast a
-- patient erasure (DPDP §6 audit obligation — "we DID issue an OTP to
-- this mobile on date X" is itself compliance evidence). PII columns
-- on patient are scrubbed; the OTP row stays.
ALTER TABLE "consent_otp"
  ADD CONSTRAINT "consent_otp_patientId_fkey"
  FOREIGN KEY ("patientId") REFERENCES "patient"("id") ON DELETE NO ACTION;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "consent_otp" TO claims_app;
  END IF;
END
$$;

ALTER TABLE "consent_otp" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "consent_otp" FORCE ROW LEVEL SECURITY;

CREATE POLICY consent_otp_select ON "consent_otp"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY consent_otp_insert ON "consent_otp"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
-- UPDATE allowed for status flips (sent → verified | failed | expired)
-- and attempt-counter increments. Application enforces sequencing.
CREATE POLICY consent_otp_update ON "consent_otp"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
-- DELETE blocked — append-only audit artifact like consent_record.
CREATE POLICY consent_otp_no_delete ON "consent_otp"
  FOR DELETE USING (false);
