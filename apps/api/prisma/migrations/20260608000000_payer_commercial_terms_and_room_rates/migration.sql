-- Per-payer commercial terms + tenant-owned room rate catalog.
--
-- Three tenant-scoped tables introduced together because they're
-- captured at the same onboarding step (`payer_commercial_terms`):
--
--   room_category            : the tenant's room catalog (default rates)
--   room_category_payer_rate : per-payer overrides on the catalog
--   payer_commercial_terms   : structured MOU content (co-pay,
--                              deductible, TAT, sub-limits, etc.)
--
-- payerCode is the stable Payer.code (string, no FK) — matches the
-- codebase convention used by Claim, IntegrationMessage, etc.
-- We pay the cost of no orphan protection for the consistency win;
-- the Payer table is soft-delete (active=false), never hard-deleted.
--
-- RLS-FORCE on all three. Tenant cascade delete on tenantId FK.
-- room_category_payer_rate cascades when its parent room_category is
-- removed (overrides are meaningless without the category).

-- ─── room_category ──────────────────────────────────────────────

CREATE TABLE "room_category" (
    "id"             UUID         NOT NULL,
    "tenantId"       UUID         NOT NULL,
    "code"           TEXT         NOT NULL,
    "name"           TEXT         NOT NULL,
    "category"       TEXT         NOT NULL,
    "dailyRatePaise" INTEGER      NOT NULL,
    "sortOrder"      INTEGER      NOT NULL DEFAULT 0,
    "active"         BOOLEAN      NOT NULL DEFAULT TRUE,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_category_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "room_category_tenant_code_idx"
  ON "room_category"("tenantId", "code");

CREATE INDEX "room_category_tenant_active_sort_idx"
  ON "room_category"("tenantId", "active", "sortOrder");

ALTER TABLE "room_category"
  ADD CONSTRAINT "room_category_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE;

-- ─── room_category_payer_rate ───────────────────────────────────

CREATE TABLE "room_category_payer_rate" (
    "id"             UUID         NOT NULL,
    "tenantId"       UUID         NOT NULL,
    "roomCategoryId" UUID         NOT NULL,
    "payerCode"      TEXT         NOT NULL,
    "dailyRatePaise" INTEGER      NOT NULL,
    "active"         BOOLEAN      NOT NULL DEFAULT TRUE,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_category_payer_rate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "room_category_payer_rate_natural_idx"
  ON "room_category_payer_rate"("tenantId", "roomCategoryId", "payerCode");

CREATE INDEX "room_category_payer_rate_lookup_idx"
  ON "room_category_payer_rate"("tenantId", "payerCode", "active");

ALTER TABLE "room_category_payer_rate"
  ADD CONSTRAINT "room_category_payer_rate_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE;

ALTER TABLE "room_category_payer_rate"
  ADD CONSTRAINT "room_category_payer_rate_roomCategoryId_fkey"
  FOREIGN KEY ("roomCategoryId") REFERENCES "room_category"("id") ON DELETE CASCADE;

-- ─── payer_commercial_terms ─────────────────────────────────────

CREATE TABLE "payer_commercial_terms" (
    "id"                       UUID         NOT NULL,
    "tenantId"                 UUID         NOT NULL,
    "payerCode"                TEXT         NOT NULL,

    -- Required for step completion
    "copayPercent"             INTEGER,
    "copayFlatPaise"           INTEGER,
    "copayAppliesTo"           TEXT,
    "deductiblePaise"          INTEGER,
    "deductibleScope"          TEXT,

    -- Validity & lifecycle
    "effectiveFrom"            TIMESTAMP(3) NOT NULL,
    "effectiveTo"              TIMESTAMP(3),
    "signedOn"                 TIMESTAMP(3),
    "signatoryName"            TEXT,
    "noticePeriodDays"         INTEGER,
    "autoRenews"               BOOLEAN      NOT NULL DEFAULT FALSE,

    -- Operational TATs
    "preauthTatMinutes"        INTEGER,
    "claimTatMinutes"          INTEGER,
    "priorIntimationRequired"  BOOLEAN      NOT NULL DEFAULT FALSE,
    "priorIntimationHours"     INTEGER,

    -- Tariff modifiers
    "flatDiscountPercent"      INTEGER,
    "pharmacyDiscountPercent"  INTEGER,
    "implantPassThrough"       BOOLEAN      NOT NULL DEFAULT FALSE,
    "implantMarkupCapPercent"  INTEGER,

    -- Per-day sub-limits
    "roomRentCapPaisePerDay"   INTEGER,
    "icuCapPaisePerDay"        INTEGER,
    "nursingCapPaisePerDay"    INTEGER,

    -- Per-claim sub-limits
    "consultationCapPaise"     INTEGER,
    "ambulanceCapPaise"        INTEGER,

    -- Coverage rules
    "preExistingWaitingMonths" INTEGER,
    "maternityCovered"         BOOLEAN      NOT NULL DEFAULT FALSE,
    "maternityWaitingMonths"   INTEGER,
    "dayCareProceduresCovered" BOOLEAN      NOT NULL DEFAULT TRUE,
    "modernTreatmentsCovered"  BOOLEAN      NOT NULL DEFAULT FALSE,

    -- Settlement
    "paymentTermDays"          INTEGER,
    "paymentMode"              TEXT,
    "bankAccountRef"           TEXT,
    "tdsPercent"               INTEGER,
    "interestOnDelayedPercent" INTEGER,
    "disputeEscalationDays"    INTEGER,

    -- Network / compliance
    "networkCategory"          TEXT,
    "nabhRequired"             BOOLEAN      NOT NULL DEFAULT FALSE,
    "nablRequired"             BOOLEAN      NOT NULL DEFAULT FALSE,
    "empanelledSpecialties"    TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],

    -- Metadata
    "notes"                    TEXT,
    "active"                   BOOLEAN      NOT NULL DEFAULT TRUE,
    "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payer_commercial_terms_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payer_commercial_terms_natural_idx"
  ON "payer_commercial_terms"("tenantId", "payerCode");

CREATE INDEX "payer_commercial_terms_tenant_active_idx"
  ON "payer_commercial_terms"("tenantId", "active");

CREATE INDEX "payer_commercial_terms_tenant_effectiveTo_idx"
  ON "payer_commercial_terms"("tenantId", "effectiveTo");

ALTER TABLE "payer_commercial_terms"
  ADD CONSTRAINT "payer_commercial_terms_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE;

-- ─── GRANTs ─────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "room_category"             TO claims_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "room_category_payer_rate"  TO claims_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "payer_commercial_terms"    TO claims_app;
  END IF;
END
$$;

-- ─── RLS-FORCE ──────────────────────────────────────────────────

ALTER TABLE "room_category"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "room_category"             FORCE  ROW LEVEL SECURITY;
ALTER TABLE "room_category_payer_rate"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "room_category_payer_rate"  FORCE  ROW LEVEL SECURITY;
ALTER TABLE "payer_commercial_terms"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payer_commercial_terms"    FORCE  ROW LEVEL SECURITY;

-- room_category
CREATE POLICY room_category_select ON "room_category"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY room_category_insert ON "room_category"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY room_category_update ON "room_category"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY room_category_delete ON "room_category"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

-- room_category_payer_rate
CREATE POLICY room_category_payer_rate_select ON "room_category_payer_rate"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY room_category_payer_rate_insert ON "room_category_payer_rate"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY room_category_payer_rate_update ON "room_category_payer_rate"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY room_category_payer_rate_delete ON "room_category_payer_rate"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

-- payer_commercial_terms
CREATE POLICY payer_commercial_terms_select ON "payer_commercial_terms"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY payer_commercial_terms_insert ON "payer_commercial_terms"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY payer_commercial_terms_update ON "payer_commercial_terms"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
CREATE POLICY payer_commercial_terms_delete ON "payer_commercial_terms"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );
