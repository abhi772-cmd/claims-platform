-- Slice BG — PMJAY biometric gate.
--
-- 1. Tenant gets a `pmjayMode` toggle. 'on' enables the PMJAY-via-NHCX
--    flow which mandates ABDM biometric / face / iris verification
--    before preauth submit and before claim submit. 'off' is the
--    default — non-PMJAY tenants don't pay the integration tax.
--
-- 2. New `biometric_verification` table records successful ABDM
--    verifications. The PreauthService + ClaimSubmitService consult
--    this table to gate submission when the tenant is in pmjayMode='on'.
--    We don't store the ABHA token here — BG only needs the gate; a
--    follow-up slice will add encrypted token storage when the FHIR
--    Bundle wiring lands.

ALTER TABLE "tenant"
  ADD COLUMN "pmjayMode" TEXT NOT NULL DEFAULT 'off';

CREATE TABLE "biometric_verification" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "process" TEXT NOT NULL,
    "authMode" TEXT NOT NULL,
    "loginHint" TEXT NOT NULL,
    "loginIdHash" TEXT NOT NULL,
    "abdmTxnId" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "biometric_verification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "biometric_verification_tenantId_caseId_process_expiresAt_idx"
  ON "biometric_verification"("tenantId", "caseId", "process", "expiresAt");

ALTER TABLE "biometric_verification"
  ADD CONSTRAINT "biometric_verification_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE;

ALTER TABLE "biometric_verification"
  ADD CONSTRAINT "biometric_verification_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "case"("id") ON DELETE CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "biometric_verification" TO claims_app;
  END IF;
END
$$;

ALTER TABLE "biometric_verification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "biometric_verification" FORCE ROW LEVEL SECURITY;

CREATE POLICY biometric_verification_select ON "biometric_verification"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY biometric_verification_insert ON "biometric_verification"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY biometric_verification_update ON "biometric_verification"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY biometric_verification_delete ON "biometric_verification"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
