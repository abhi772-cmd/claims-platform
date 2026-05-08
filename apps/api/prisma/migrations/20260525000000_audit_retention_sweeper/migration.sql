-- Slice BP — audit_log retention sweeper.
--
-- BO stamped a retention class on every row. BP ships the
-- mechanism to actually delete rows past their floor. Three pieces:
--   1. A new RLS policy `audit_log_delete_retention` allows DELETE
--      when the caller has set `app.role = 'retention_sweeper'`.
--      The existing `audit_log_no_delete` USING(false) policy still
--      blocks every other role; both policies are OR'd at the row
--      level, so the sweep role can delete and nothing else can.
--   2. A SECURITY INVOKER function `audit_retention_sweep(class, floor_days)`
--      deletes matching rows and returns the count. The caller is
--      expected to have set `app.role = 'retention_sweeper'` in
--      the surrounding transaction; we don't bypass RLS via
--      SECURITY DEFINER because we want the role-context audit
--      trail to be honest.
--   3. EXECUTE granted to claims_app so the runtime role can call
--      the function (the role-policy still gates the actual
--      DELETE).
--
-- Multi-replica concern: this slice doesn't ship an in-app cron
-- because Redis is deferred and a naive interval-based scheduler
-- would race across replicas. Triggering is via the CLI script
-- (`pnpm --filter @claims/api audit:retention-sweep`) which ops can
-- wire to an external scheduler (k8s CronJob / cloud cron / pg_cron).

-- 1a. Allow DELETE for the retention_sweeper role.
CREATE POLICY audit_log_delete_retention ON "audit_log"
  FOR DELETE USING (app_current_role() = 'retention_sweeper');

-- 1b. Extend SELECT to also permit retention_sweeper. PG evaluates
-- DELETE's WHERE-scan through the SELECT policy first; without this
-- the sweeper finds zero rows even though its DELETE USING clause
-- would permit them. The new role still doesn't see anything outside
-- of audit_log because we add it only here.
DROP POLICY audit_log_select ON "audit_log";
CREATE POLICY audit_log_select ON "audit_log"
  FOR SELECT USING (
    app_current_role() = 'platform_admin'
    OR app_current_role() = 'retention_sweeper'
    OR ("tenantId" = app_current_tenant_id())
  );

-- 2. The sweep function. Returns the count of rows deleted in this
-- call. Plain SQL is enough — no plpgsql needed.
CREATE OR REPLACE FUNCTION audit_retention_sweep(
  p_class TEXT,
  p_floor_days INTEGER
) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  IF p_floor_days IS NULL OR p_floor_days <= 0 THEN
    RAISE EXCEPTION 'audit_retention_sweep: p_floor_days must be > 0 (got %)', p_floor_days;
  END IF;
  IF p_class IS NULL OR p_class = '' THEN
    RAISE EXCEPTION 'audit_retention_sweep: p_class must be non-empty';
  END IF;
  -- The DELETE runs under whatever role the caller set on app.role.
  -- The retention policy above gates this; if the caller forgot to
  -- flip the role, the DELETE is silently dropped and v_deleted = 0.
  -- We rely on the test e2e to catch that misuse.
  DELETE FROM "audit_log"
   WHERE "retentionClass" = p_class
     AND "occurredAt" < (now() - make_interval(days => p_floor_days));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- 3. Allow the runtime role to call the function. The policy gates
-- the actual deletion, so EXECUTE alone doesn't grant deletion
-- power.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claims_app') THEN
    GRANT EXECUTE ON FUNCTION audit_retention_sweep(TEXT, INTEGER) TO claims_app;
  END IF;
END
$$;
