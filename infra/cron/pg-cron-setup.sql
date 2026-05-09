-- Slice CC — pg_cron production setup for the audit retention sweeper.
--
-- Runs the BP `audit_retention_sweep(class, floor_days)` Postgres
-- function for each retention class on a nightly cadence. The
-- function itself is gated on `app.role = 'retention_sweeper'`
-- via the audit_log_delete_retention RLS policy; we set the GUC
-- inside each cron job's transaction so the DELETE policy permits.
--
-- Prerequisites:
--   * pg_cron extension installed at the cluster level. On Neon and
--     most managed Postgres providers this is a one-line CREATE
--     EXTENSION (must be run by a cluster superuser, not the app
--     role). Self-hosted ops should follow the cluster's pg_cron
--     install guide (shared_preload_libraries='pg_cron' in postgresql.conf,
--     restart, then CREATE EXTENSION pg_cron;).
--   * The audit_retention_sweep() function from migration
--     20260525000000_audit_retention_sweeper must be deployed.
--
-- This file is paste-and-run on the production DB by ops once.
-- It's not a Prisma migration because pg_cron extension creation
-- requires superuser and Prisma's DATABASE_URL_MIGRATOR doesn't
-- carry that role in our setup.

-- 1. Enable the extension. Idempotent.
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 2. Drop any prior schedules so re-running this script is safe.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname LIKE 'audit_retention_sweep_%';

-- 3. Schedule per-class sweeps. The floor-days values mirror
--    apps/api/src/modules/audit/retention-classes.ts
--    RETENTION_FLOOR_DAYS — keep them in lockstep when the floor
--    map changes (e.g. if DigiSparsh-lending slips out of v1 and
--    financial drops from RBI 10y to IRDAI 5y).
--
-- Cadence: 02:30 IST nightly per class, staggered 5 minutes apart
-- so a slow class doesn't delay the next. UTC offset adjusted for
-- IST (-5:30): 21:00 UTC, 21:05 UTC, ..., 21:25 UTC.
SELECT cron.schedule(
    'audit_retention_sweep_session',
    '0 21 * * *',
    $$
    DO $body$ BEGIN
      PERFORM set_config('app.role', 'retention_sweeper', true);
      PERFORM audit_retention_sweep('session', 90);
    END $body$;
    $$
);

SELECT cron.schedule(
    'audit_retention_sweep_security',
    '5 21 * * *',
    $$
    DO $body$ BEGIN
      PERFORM set_config('app.role', 'retention_sweeper', true);
      PERFORM audit_retention_sweep('security', 1095);
    END $body$;
    $$
);

SELECT cron.schedule(
    'audit_retention_sweep_clinical',
    '10 21 * * *',
    $$
    DO $body$ BEGIN
      PERFORM set_config('app.role', 'retention_sweeper', true);
      PERFORM audit_retention_sweep('clinical', 1825);
    END $body$;
    $$
);

SELECT cron.schedule(
    'audit_retention_sweep_governance',
    '15 21 * * *',
    $$
    DO $body$ BEGIN
      PERFORM set_config('app.role', 'retention_sweeper', true);
      PERFORM audit_retention_sweep('governance', 2920);
    END $body$;
    $$
);

SELECT cron.schedule(
    'audit_retention_sweep_consent',
    '20 21 * * *',
    $$
    DO $body$ BEGIN
      PERFORM set_config('app.role', 'retention_sweeper', true);
      PERFORM audit_retention_sweep('consent', 2920);
    END $body$;
    $$
);

SELECT cron.schedule(
    'audit_retention_sweep_financial',
    '25 21 * * *',
    $$
    DO $body$ BEGIN
      PERFORM set_config('app.role', 'retention_sweeper', true);
      PERFORM audit_retention_sweep('financial', 3650);
    END $body$;
    $$
);

-- 4. Inspect schedules + last-run results:
--    SELECT jobname, schedule, command FROM cron.job
--    WHERE jobname LIKE 'audit_retention_sweep_%' ORDER BY jobname;
--
--    SELECT jobid, runid, status, return_message, start_time, end_time
--    FROM cron.job_run_details
--    WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname LIKE 'audit_retention_sweep_%')
--    ORDER BY start_time DESC
--    LIMIT 20;

-- Note on the breach detector (BS): it lives in TS service code
-- (BreachDetectorService.scan) because it needs Prisma + per-tenant
-- inserts under runInTenantContext. pg_cron can only invoke SQL,
-- so the breach detector runs from an external scheduler instead
-- (k8s CronJob or cloud cron calling `pnpm --filter @claims/api
-- breach:scan`). See infra/cron/cloud-cron.yaml for an example.
