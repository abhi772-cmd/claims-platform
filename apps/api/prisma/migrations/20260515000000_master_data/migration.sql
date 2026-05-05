-- Slice O — master data: payer, package, icd_code, billing_code,
-- document_checklist_rule. Platform-level reference tables — no
-- tenantId column. SELECT is open to any authenticated context.
-- INSERT/UPDATE/DELETE is platform_admin-only.

-- =====================================================
-- payer
-- =====================================================
CREATE TABLE "payer" (
    "id"            UUID NOT NULL,
    "code"          TEXT NOT NULL,
    "name"          TEXT NOT NULL,
    "payerType"     TEXT NOT NULL,
    "rail"          TEXT NOT NULL,
    "hcxCode"       TEXT,
    "active"        BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo"   TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payer_code_key" ON "payer"("code");
CREATE INDEX "payer_rail_active_idx" ON "payer"("rail", "active");
CREATE INDEX "payer_effectiveFrom_effectiveTo_idx"
  ON "payer"("effectiveFrom", "effectiveTo");

-- =====================================================
-- package
-- =====================================================
CREATE TABLE "package" (
    "id"            UUID NOT NULL,
    "code"          TEXT NOT NULL,
    "name"          TEXT NOT NULL,
    "category"      TEXT,
    "amount"        INTEGER NOT NULL,
    "pmjayHbp"      BOOLEAN NOT NULL DEFAULT false,
    "active"        BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo"   TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "package_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "package_code_key" ON "package"("code");
CREATE INDEX "package_category_active_idx" ON "package"("category", "active");
CREATE INDEX "package_pmjayHbp_active_idx" ON "package"("pmjayHbp", "active");

-- =====================================================
-- icd_code
-- =====================================================
CREATE TABLE "icd_code" (
    "code"        TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "chapter"     TEXT,
    "active"      BOOLEAN NOT NULL DEFAULT true,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "icd_code_pkey" PRIMARY KEY ("code")
);
CREATE INDEX "icd_code_active_idx" ON "icd_code"("active");

-- =====================================================
-- billing_code
-- =====================================================
CREATE TABLE "billing_code" (
    "code"        TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category"    TEXT,
    "baseAmount"  INTEGER,
    "active"      BOOLEAN NOT NULL DEFAULT true,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_code_pkey" PRIMARY KEY ("code")
);
CREATE INDEX "billing_code_category_active_idx"
  ON "billing_code"("category", "active");

-- =====================================================
-- document_checklist_rule
-- =====================================================
CREATE TABLE "document_checklist_rule" (
    "id"            UUID NOT NULL,
    "phase"         TEXT NOT NULL,
    "rail"          TEXT NOT NULL,
    "documentType"  TEXT NOT NULL,
    "required"      BOOLEAN NOT NULL DEFAULT true,
    "payerCode"     TEXT,
    "packageCode"   TEXT,
    "admissionType" TEXT,
    "conditions"    JSONB NOT NULL DEFAULT '{}',
    "active"        BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo"   TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_checklist_rule_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "document_checklist_rule_phase_rail_active_idx"
  ON "document_checklist_rule"("phase", "rail", "active");
CREATE INDEX "document_checklist_rule_payerCode_packageCode_idx"
  ON "document_checklist_rule"("payerCode", "packageCode");

-- =====================================================
-- Grants + RLS
-- =====================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "payer" TO claims_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "package" TO claims_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "icd_code" TO claims_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "billing_code" TO claims_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "document_checklist_rule" TO claims_app;
  END IF;
END
$$;

-- payer
ALTER TABLE "payer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payer" FORCE ROW LEVEL SECURITY;

CREATE POLICY payer_select ON "payer" FOR SELECT USING (
  app_current_role() IN ('platform_admin', 'tenant')
);
CREATE POLICY payer_insert ON "payer" FOR INSERT
  WITH CHECK (app_current_role() = 'platform_admin');
CREATE POLICY payer_update ON "payer" FOR UPDATE
  USING (app_current_role() = 'platform_admin')
  WITH CHECK (app_current_role() = 'platform_admin');
CREATE POLICY payer_delete ON "payer" FOR DELETE
  USING (app_current_role() = 'platform_admin');

-- package
ALTER TABLE "package" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "package" FORCE ROW LEVEL SECURITY;

CREATE POLICY package_select ON "package" FOR SELECT USING (
  app_current_role() IN ('platform_admin', 'tenant')
);
CREATE POLICY package_insert ON "package" FOR INSERT
  WITH CHECK (app_current_role() = 'platform_admin');
CREATE POLICY package_update ON "package" FOR UPDATE
  USING (app_current_role() = 'platform_admin')
  WITH CHECK (app_current_role() = 'platform_admin');
CREATE POLICY package_delete ON "package" FOR DELETE
  USING (app_current_role() = 'platform_admin');

-- icd_code
ALTER TABLE "icd_code" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "icd_code" FORCE ROW LEVEL SECURITY;

CREATE POLICY icd_code_select ON "icd_code" FOR SELECT USING (
  app_current_role() IN ('platform_admin', 'tenant')
);
CREATE POLICY icd_code_insert ON "icd_code" FOR INSERT
  WITH CHECK (app_current_role() = 'platform_admin');
CREATE POLICY icd_code_update ON "icd_code" FOR UPDATE
  USING (app_current_role() = 'platform_admin')
  WITH CHECK (app_current_role() = 'platform_admin');
CREATE POLICY icd_code_delete ON "icd_code" FOR DELETE
  USING (app_current_role() = 'platform_admin');

-- billing_code
ALTER TABLE "billing_code" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_code" FORCE ROW LEVEL SECURITY;

CREATE POLICY billing_code_select ON "billing_code" FOR SELECT USING (
  app_current_role() IN ('platform_admin', 'tenant')
);
CREATE POLICY billing_code_insert ON "billing_code" FOR INSERT
  WITH CHECK (app_current_role() = 'platform_admin');
CREATE POLICY billing_code_update ON "billing_code" FOR UPDATE
  USING (app_current_role() = 'platform_admin')
  WITH CHECK (app_current_role() = 'platform_admin');
CREATE POLICY billing_code_delete ON "billing_code" FOR DELETE
  USING (app_current_role() = 'platform_admin');

-- document_checklist_rule
ALTER TABLE "document_checklist_rule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_checklist_rule" FORCE ROW LEVEL SECURITY;

CREATE POLICY document_checklist_rule_select ON "document_checklist_rule"
  FOR SELECT USING (
    app_current_role() IN ('platform_admin', 'tenant')
  );
CREATE POLICY document_checklist_rule_insert ON "document_checklist_rule"
  FOR INSERT WITH CHECK (app_current_role() = 'platform_admin');
CREATE POLICY document_checklist_rule_update ON "document_checklist_rule"
  FOR UPDATE
  USING (app_current_role() = 'platform_admin')
  WITH CHECK (app_current_role() = 'platform_admin');
CREATE POLICY document_checklist_rule_delete ON "document_checklist_rule"
  FOR DELETE USING (app_current_role() = 'platform_admin');
