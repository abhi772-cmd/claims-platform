# Sprint 8 — Exit document

Sprint window: started after PR #75 (Sprint 7 exit doc) merged on
2026-05-08; this doc is written at the Sprint 8 paperwork pause on
2026-05-09 with PR #82 (Slice BU) and the PrismaService timeout
hotfix (PR #83) on `main`.

## What shipped

Seven slices, the entire **audit-retention axis**. Sprint 7's exit
doc projected this work as a two-sprint axis (Sprint 8 = BO–BR core,
Sprint 9 = BS–BU polish + per-payer extractors + perf). The split
collapsed: the polish slices (BS, BT, BU) ran tightly enough on top
of the core (BO–BR) that they all landed inside Sprint 8. Sprint 9
is now scoped to per-payer extractors + perf hardening alone, plus
the parallel Python OCR machine.

| Slice | Theme                                                                          | PR  |
| ----- | ------------------------------------------------------------------------------ | --- |
| BO    | `audit_log.retentionClass` column + classifier + backfill                      | #76 |
| BP    | `audit_retention_sweep` Postgres function + sweeper service + CLI              | #77 |
| BQ    | DPDP §11 erasure-on-request workflow + endpoint + claims-active gate           | #78 |
| BR    | DPDP §17 data access ledger + `@LogsPiiAccess` interceptor                     | #79 |
| BS    | DPDP §8(6) breach detection (BURST_DECRYPT) + 72h notification template        | #80 |
| BT    | DPDP §6 / Rule 8 consent record + access-ledger binding                        | #81 |
| BU    | Compliance dashboard endpoint + admin page                                     | #82 |

Plus one hotfix PR landed in the Sprint 8 window:

| PR  | Theme                                                                          |
| --- | ------------------------------------------------------------------------------ |
| #83 | `PrismaService.runInTenantContext` tx timeout 5s → 30s; maxWait 2s → 10s       |

See `CHANGELOG.md` for per-slice detail. Per-PR CHANGELOG discipline
held throughout — no backfill chore needed.

## Test coverage at exit

| Suite (representative)                                    | Cases | Notes                                                         |
| --------------------------------------------------------- | ----- | ------------------------------------------------------------- |
| `retention-classes.spec` (BO)                             |  17   | Six classes + classifier coverage + floor invariants          |
| `audit-retention-class.e2e`                               |   4   | BO — write-time stamp + backfill correctness                  |
| `audit-retention-sweeper.e2e`                             |   4   | BP — past-floor sweep + RLS canary + bad-input rejection      |
| `erasure-request.e2e`                                     |   6   | BQ — completed / rejected / closed-claim-not-blocking / RLS   |
| `data-access-event.e2e`                                   |   5   | BR — list / export / decrypt-binding / unspecified / RLS      |
| `dpdp-notification-template.spec`                         |   6   | BS — six §8(6) sections + kind-specific copy + 72h constant   |
| `breach-incident.e2e`                                     |   8   | BS — detection / idempotency / file / notify / dismiss / RLS  |
| `consent-record.e2e`                                      |   8   | BT — grant / withdraw / requireConsent / expiry / binding / RLS |
| `compliance-dashboard.e2e`                                |   5   | BU — payload shape / overdue flag / consent status / RLS      |
| **Sprint 8 additions**                                    | **~63** | On top of ~500 cases from Sprints 1–7                       |

Full suite at exit: **~52 spec files** integration; **~25 cases**
unit + ~38 cases integration added this sprint. CI integration
runner heap ceiling held at 4 GB (set in Sprint 7); no new heap
pressure observed.

## Decisions worth remembering

- **Strictest-of-three retention floor is locked at six classes**
  in `retention-classes.ts`: financial (RBI 10y), clinical (IRDAI 5y),
  security (3y DPDP/IRDAI investigation), session (90d DPDP transit),
  governance (8y operational), consent (held until withdrawal +
  statutory floor under Rule 8). The class is a stable semantic
  label written at audit row insert; the year mapping lives in
  `RETENTION_FLOOR_DAYS` so policy can change without a schema
  migration. **If DigiSparsh-lending slips out of v1, the financial
  floor collapses to IRDAI 5y** — only that map needs to change,
  not the column or the classifier.
- **Append-only via RLS, not DELETE permission.** Three new tables
  (`erasure_request`, `data_access_event`, `breach_incident`,
  `consent_record`) all use `FOR DELETE USING (false)` to make
  deletion structurally impossible at the runtime role. The BP
  retention sweeper is the *only* DELETE pathway against
  `audit_log` and is gated by a dedicated `retention_sweeper` GUC
  role. New compliance tables should follow this shape.
- **RLS DELETE filters through the SELECT policy first.** Caught
  in BP CI: a `retention_sweeper` role with a permissive DELETE
  policy but no SELECT policy silently returned 0 affected rows
  because PG evaluates the DELETE WHERE-scan via SELECT. Saved as
  a feedback memory because the lesson generalises to any future
  privileged-role + RLS surface.
- **PL/pgSQL function calls cloud GUC visibility on some PG
  versions.** Switched the BP sweeper from calling the
  `audit_retention_sweep(...)` SQL function to a Prisma
  `deleteMany` inside the same tx with the GUC set. The function
  still exists for direct SQL / pg_cron callers (the production
  cadence wiring), but the in-app path skips the PL/pgSQL boundary.
- **Erasure carve-out: claims-active gate uses a broader set than
  the state-machine's TERMINAL_STATUSES.** `ERASABLE_CLAIM_STATUSES`
  in `erasure-request.service.ts` includes `WRITTEN_OFF` alongside
  `CLOSED` and `ABANDONED` — a write-off is functionally terminal
  for DPDP purposes (we've stopped chasing payment) even though
  the state-machine treats it differently for clinical workflow.
  New erasure-touching logic should read this constant, not
  TERMINAL_STATUSES.
- **Decrypt-time access logging is fire-and-forget.** In
  `PatientService.getDecrypted`, the access-log write is `void
  this.accessLog.record(...).catch(() => undefined)` *before* the
  `tenantKey()` derivation. Two reasons: (1) operators need to see
  that a row was touched even when downstream key derivation
  throws (missing master key, rotated DEK version, truncated
  ciphertext), and (2) log failures must never break a decryption
  that orchestrators depend on. The same pattern applies to the
  HTTP-level interceptor — `tap.next` writes happen after the
  response has been computed.
- **Detector idempotency via composite unique key.** BS's
  BURST_DECRYPT detector uses `(tenantId, kind, actorUserId,
  windowStart)` unique on `breach_incident` and rounds
  `windowStart` down to the minute boundary. Re-running `scan()`
  multiple times within the same minute converges on the same row.
  Manual reports leave `actorUserId` and `windowStart` null and
  naturally skip the constraint (PG NULL ≠ NULL semantics). New
  detectors should follow this shape — never rely on application-
  side deduplication when the database can guarantee it.
- **DPDP §8(6) template is a renderer, not a sender.** BS's
  `dpdp-notification-template.ts` produces structured `{subject,
  body, fields}` snapshots that operators copy into the Data
  Protection Board's portal. We do *not* automate submission to
  the DPB — there's no public DPB API yet, and operators must
  review the rendered text before any §8(6) filing. The
  `DPDP_NOTIFICATION_WINDOW_MS` constant (72h) is centralised so
  the deadline calculation is a single source of truth.
- **Consent binding is loose-coupled at the uuid level.**
  `data_access_event.consentGrantId` has no FK to `consent_record`
  — the ledger row must outlive any future migration that drops
  consent rows. BU's dashboard joins defensively: `LEFT JOIN
  consent_record c ON c.id = e.consentGrantId`, with a "withdrawn"
  / "expired" / "unbound" badge for the various states. Future
  binding columns on the ledger should follow this shape.
- **`requireConsent` is the call-site guard.** BT's
  `ConsentService.requireConsent(tenantId, patientId, consentType)`
  throws `ValidationFailedError` when no active grant exists.
  Service code gating PII reads (preauth submit, claim submit, the
  decrypt path itself in future iterations) should use this; pure-
  data list paths where Patient.fullName is intentionally
  redacted don't need it. Wiring this into existing service code
  is **deliberately deferred** — Sprint 8 ships the surface; Sprint
  9 or a hotfix can thread it through where the lawful basis is
  consent and not a §7 carve-out.
- **Compliance dashboard is read-only by design.** BU's
  `/admin/compliance/dashboard` endpoint is a single tenant-scoped
  rollup; it does not expose any state-mutation surface of its
  own. The page reuses BS's notify/dismiss + breach-scan endpoints
  inline so operators stay on one screen, but the API surface
  stays separated.
- **Cross-region Neon adds tx-timeout pressure.** Hotfix PR #83
  bumped Prisma's transaction timeout from 5s to 30s in
  `runInTenantContext` after `POST /auth/login` failed
  intermittently against Neon (5+ serial round-trips inside one
  tx exceeded the 5s default). 30s gives comfortable headroom for
  any tenant operation we'd reasonably wrap in one tx; anything
  genuinely slower than that should not be in a tenant tx at all.
  Production OVH-region Postgres won't hit this.

## Operational additions

- **CLIs**: `pnpm --filter @claims/api audit:retention-sweep` (BP),
  `pnpm --filter @claims/api breach:scan` (BS),
  `pnpm --filter @claims/api db:seed:demo` (Sprint 8 wrap-up —
  populates the dashboard with three patients, six consents,
  fourteen decrypts, three erasures, three breaches including one
  overdue, and audit rows across retention classes, for visual
  verification of the BU surface).
- **Production cadence**: external scheduler (k8s CronJob, cloud
  cron, or pg_cron) invokes `audit:retention-sweep` nightly and
  `breach:scan` every 10–15 min. We don't ship in-app cron because
  Redis is deferred and a naive `setInterval` would race across
  replicas.
- **Permissions seeded**: `breach_incident.view` + `.manage`
  (platform_admin, tenant_admin), `consent.view` + `.manage`
  (platform_admin, tenant_admin, billing_manager,
  insurance_desk_executive — intake desks need to capture consent
  at admission). View is broader than manage everywhere; manage
  always implies view.

## Open questions for the user

1. **Wire `requireConsent` into service code.** Sprint 8 ships
   the consent surface; preauth submit, claim submit, and the
   decrypt path don't yet call `consentService.requireConsent`
   before reading PII. This is the difference between "we have
   the audit story" and "we enforce the audit story". Worth doing
   in Sprint 9 alongside the per-payer extractors, or hotfix
   first?
2. **Production cron wiring.** External scheduler decision — k8s
   CronJob (we don't have a cluster yet), cloud cron (OVH supports
   it), or pg_cron (in-DB). pg_cron is the simplest and survives
   our Redis-deferred posture. Worth deciding before go-live so
   the BP / BS sweepers actually run on a cadence in production.
3. **Lending v1 confirmation.** RBI 10y `financial` retention
   floor assumes DigiSparsh-lending is in v1. If lending slips,
   the floor collapses to IRDAI 5y and we save half the
   `audit_log` storage. Worth a final yes/no before any production
   data lands.
4. **Sandbox PMJAY participant for end-to-end runs.** Open since
   Sprint 7 exit. The Sprint 7 onboarding CLI (BN) needs an OTP
   from a real PMJAY sandbox to provision a participant id +
   bearer token; until then the PMJAY adapter stays in stub mode.
5. **OVH KMS provisioning timing.** Open since Sprint 5. The
   wrap-format and adapter abstraction are ready; flipping the env
   variable + provisioning the OVH KMS instance is a one-deploy
   change. Worth doing pre-go-live, or defer until first paying
   tenant?

## Sprint 9 likely shape

With the audit-retention axis closed inside Sprint 8, Sprint 9 is
narrowed to the items that were originally projected as Sprint 8
overflow:

- **OCR machine v0 + v1** — separate Python repo. FastAPI
  implementing the multipart `/extract` contract that the existing
  TS adapter (Slice AX) already calls. Stack: PaddleOCR
  (text + bbox) + Qwen2-VL or GOT-OCR2.0 (key-value extraction) +
  per-payer prompt tuning. Top six payers: Star, Bajaj, ICICI
  Lombard, HDFC Ergo, Mediassist, Paramount. Estimated thin v0
  (PaddleOCR + regex, ~60% EOBs) ships in 3–4 days; full v1 in
  1.5–2.5 weeks. Runs in parallel with the TS work.
- **Per-payer extractor framework on the TS side** — payer
  detection from EOB header / metadata + per-payer normalisation
  rules that map raw OCR JSON to claim events. Sprint 9 likely
  ships the framework + 1–2 payers; the remaining four follow as
  the OCR machine matures.
- **Perf hardening** — index review on the new tables
  (`data_access_event`, `breach_incident`, `consent_record`),
  pg_cron wiring for the BP / BS schedulers, connection pool
  tuning for cross-region Postgres.
- **Optional**: thread `requireConsent` into service code (open
  question 1 above).

Estimated Sprint 9 = **~3 weeks of TS work + 1.5–2.5 weeks of
parallel Python OCR work**. After Sprint 9 the stack is feature-
complete for v1 launch (modulo OVH KMS + Redis flips at deployment
time). Time-to-production estimate from 2026-05-07 (~9 weeks of TS
work) is now ~3 weeks remaining + the deferred infra work.
