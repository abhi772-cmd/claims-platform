# Production cron wiring

Sprint 8's audit retention sweeper (BP) and breach detector (BS)
both rely on cadence to be useful in production. This doc is the
operator runbook for wiring them up at deploy-time.

## Two cadence jobs

| Job                     | What                                                                            | Cadence              | Lives where      |
| ----------------------- | ------------------------------------------------------------------------------- | -------------------- | ---------------- |
| **Retention sweep**     | Deletes audit_log rows past their retention floor, per class.                   | Nightly (~02:30 IST) | SQL (`audit_retention_sweep`) |
| **Breach detector scan** | Looks at the past 60 minutes of `data_access_event`, opens incidents on bursts. | Every 15 minutes     | TS (`BreachDetectorService.scan`) |

## Path A — pg_cron (recommended for the retention sweep)

The retention sweep is pure SQL (the `audit_retention_sweep(class,
floor_days)` Postgres function from migration
`20260525000000_audit_retention_sweeper`). pg_cron can call it
directly — no external scheduler, no app process needed.

**Setup** (run once, by a cluster superuser):

```sh
psql "$DATABASE_URL_SUPERUSER" -f infra/cron/pg-cron-setup.sql
```

The SQL file:
1. `CREATE EXTENSION IF NOT EXISTS pg_cron`.
2. Drops any prior `audit_retention_sweep_*` schedules so re-runs
   are safe.
3. Schedules per-class sweeps at 02:30–02:55 IST nightly.

**Inspect**:

```sql
-- What's scheduled?
SELECT jobname, schedule, command FROM cron.job
WHERE jobname LIKE 'audit_retention_sweep_%'
ORDER BY jobname;

-- Last 20 runs across all retention sweeps.
SELECT jobid, status, return_message, start_time, end_time
FROM cron.job_run_details
WHERE jobid IN (
  SELECT jobid FROM cron.job WHERE jobname LIKE 'audit_retention_sweep_%'
)
ORDER BY start_time DESC LIMIT 20;
```

**When pg_cron isn't available**: many self-hosted Postgres
deployments don't enable pg_cron (it requires
`shared_preload_libraries='pg_cron'` + a cluster restart). For
those, fall back to Path B.

## Path B — cloud cron / k8s CronJob

The breach detector lives in TS service code (`BreachDetectorService`)
because it does Prisma + per-tenant inserts under
`runInTenantContext`. pg_cron can't invoke Node code, so the
detector always needs an external scheduler. The same scheduler
can also run the retention sweep when pg_cron is unavailable.

See `infra/cron/cloud-cron.yaml` for a generic config that maps
onto k8s CronJob, OVH cron, GCP Cloud Scheduler, or AWS
EventBridge. Adapt to whichever you operate.

**Pick one**: pg_cron (Path A) OR the cloud-cron retention-sweep
job (Path B). Running both will double-sweep nightly — harmless
in deletion (the second pass finds nothing) but wastes cycles.

The breach scan ALWAYS runs from Path B regardless.

## Cadence rationale

- **Retention sweep nightly**: storage growth is slow; daily is
  enough. The sweep is heavy on the financial class (potentially
  10y of audit rows) but Postgres handles per-class index-driven
  DELETE in seconds even on millions of rows.
- **Breach detector every 15 min**: BURST_DECRYPT detection
  reads the past 60-minute window. With a 15-minute cadence each
  burst gets four scans before the window slides off; we'll
  always catch it. Tighter (5-minute) cadence is fine — the
  detector is idempotent within the same minute boundary
  (unique constraint on
  `(tenantId, kind, actorUserId, windowStart)`). Looser
  (hourly) means a burst could go up to ~75 minutes between
  detection and the breach incident getting opened — still well
  inside the 72-hour DPDP §8(6) window but worth shortening if
  the tenant is high-volume.

## Manual fallback

If the scheduler is broken, ops can always run the CLIs from
any host with the API image:

```sh
pnpm --filter @claims/api audit:retention-sweep
pnpm --filter @claims/api breach:scan
pnpm --filter @claims/api breach:scan -- --window-minutes=120
```

Both print structured JSON to stdout — pipe to the log
aggregator. Both are idempotent inside their respective windows
(retention sweep deletes only past-floor rows; breach scan
deduplicates via the unique constraint).

## What's NOT scheduled (yet)

- **Consent expiry sweep** — BT consents with `expiresAt < now`
  stay marked `granted` until something queries them; the
  `findActiveFor` filter excludes them at read time, but the
  status column doesn't auto-flip. A future slice can add an
  `expire_consents_past_due` SQL function + pg_cron schedule.
- **Erasure auto-retry** — BQ erasure requests in `rejected` state
  could be auto-retried when the blocking claims close. Today
  this needs operator action.

Both are deliberate v1 omissions — the BU dashboard surfaces them
for triage and operators handle them on the existing screens.
