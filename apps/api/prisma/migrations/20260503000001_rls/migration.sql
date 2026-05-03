-- Tenant isolation via PostgreSQL RLS.
--
-- Design notes:
--  * All policies read current_setting('app.tenant_id', true) and
--    current_setting('app.role', true). The interceptor sets these via
--    set_config() at the start of every transaction. The parameterised
--    set_config call is the only safe way to bind tenant ids — never use
--    template-string interpolation. See CLAUDE.md rule 3.
--  * "claims_migrator" owns these tables but FORCE RLS is enabled, so the
--    owner is also subject to the policies. The canary integration test
--    proves this — see test/integration/tenant-isolation.e2e-spec.ts.
--  * "claims_app" is the runtime role. It does not have BYPASSRLS.
--  * audit_log is append-only via WITH CHECK on insert and USING(false)
--    on update/delete.

-- =====================================================
-- Grants
-- =====================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      "tenant", "role", "user", "user_role", "session", "session_token_history", "audit_log"
      TO claims_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO claims_app;
  END IF;
END
$$;

-- =====================================================
-- Helper: read current tenant id as UUID, or NULL.
-- =====================================================
CREATE OR REPLACE FUNCTION app_current_tenant_id() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v text;
BEGIN
  v := current_setting('app.tenant_id', true);
  IF v IS NULL OR v = '' THEN
    RETURN NULL;
  END IF;
  RETURN v::uuid;
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION app_current_role() RETURNS text
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN COALESCE(current_setting('app.role', true), '');
END
$$;

-- =====================================================
-- Tenant table
-- =====================================================
ALTER TABLE "tenant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_self_select ON "tenant"
  FOR SELECT USING (id = app_current_tenant_id() OR app_current_role() = 'platform_admin');

CREATE POLICY tenant_self_insert ON "tenant"
  FOR INSERT WITH CHECK (app_current_role() = 'platform_admin');

CREATE POLICY tenant_self_update ON "tenant"
  FOR UPDATE
  USING (id = app_current_tenant_id() OR app_current_role() = 'platform_admin')
  WITH CHECK (id = app_current_tenant_id() OR app_current_role() = 'platform_admin');

CREATE POLICY tenant_self_delete ON "tenant"
  FOR DELETE USING (app_current_role() = 'platform_admin');

-- =====================================================
-- Role table — tenant-scoped rows + platform-admin (NULL tenantId) rows
-- =====================================================
ALTER TABLE "role" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;

CREATE POLICY role_select ON "role"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" IS NULL)
    OR ("tenantId" = app_current_tenant_id())
  );

CREATE POLICY role_insert ON "role"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

CREATE POLICY role_update ON "role"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

CREATE POLICY role_delete ON "role"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

-- =====================================================
-- User table
-- =====================================================
ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user" FORCE ROW LEVEL SECURITY;

CREATE POLICY user_select ON "user"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

CREATE POLICY user_insert ON "user"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

CREATE POLICY user_update ON "user"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

CREATE POLICY user_delete ON "user"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

-- =====================================================
-- UserRole
-- =====================================================
ALTER TABLE "user_role" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_role" FORCE ROW LEVEL SECURITY;

CREATE POLICY user_role_select ON "user_role"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

CREATE POLICY user_role_insert ON "user_role"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

CREATE POLICY user_role_update ON "user_role"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

CREATE POLICY user_role_delete ON "user_role"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

-- =====================================================
-- Session
-- =====================================================
ALTER TABLE "session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session" FORCE ROW LEVEL SECURITY;

CREATE POLICY session_select ON "session"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

CREATE POLICY session_insert ON "session"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

CREATE POLICY session_update ON "session"
  FOR UPDATE
  USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  )
  WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

CREATE POLICY session_delete ON "session"
  FOR DELETE USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

-- =====================================================
-- Session token history — platform_admin-only access for security
-- (read by AuthService.refresh under platform_admin GUC)
-- =====================================================
ALTER TABLE "session_token_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_token_history" FORCE ROW LEVEL SECURITY;

CREATE POLICY session_token_history_select ON "session_token_history"
  FOR SELECT USING (app_current_role() = 'platform_admin');

CREATE POLICY session_token_history_insert ON "session_token_history"
  FOR INSERT WITH CHECK (app_current_role() = 'platform_admin');

CREATE POLICY session_token_history_no_update ON "session_token_history"
  FOR UPDATE USING (false);

CREATE POLICY session_token_history_no_delete ON "session_token_history"
  FOR DELETE USING (false);

-- =====================================================
-- Audit log — append-only.
-- INSERT allowed; UPDATE and DELETE are silently denied via false predicates.
-- =====================================================
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_log_select ON "audit_log"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

CREATE POLICY audit_log_insert ON "audit_log"
  FOR INSERT WITH CHECK (
    app_current_role() = 'platform_admin'
    OR ("tenantId" = app_current_tenant_id())
  );

CREATE POLICY audit_log_no_update ON "audit_log"
  FOR UPDATE USING (false);

CREATE POLICY audit_log_no_delete ON "audit_log"
  FOR DELETE USING (false);
