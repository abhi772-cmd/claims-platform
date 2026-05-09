# Changelog

Notable changes to the DigiSparsh Claims Platform. The format is loosely
[Keep a Changelog](https://keepachangelog.com/) but oriented around
sprint slices rather than calendar releases.

## Sprint 8 — TBD (May 2026)

Theme: **audit retention on the strictest-of-three floor (DPDP Act
2023 + DPDP Rules 2025 + IRDAI 5y for claims + RBI 10y because
DigiSparsh-lending is planned in v1)**. Sprint 8 puts the schema
and write-time stamping in place; subsequent slices ship the
sweeper (BP), erasure-on-request (BQ), data-access ledger (BR),
breach detection (BS), consent record + UI (BT), and the
compliance dashboard (BU).

### BU — DPDP / IRDAI / RBI compliance dashboard

- New `GET /admin/compliance/dashboard` endpoint returns one
  tenant-scoped rollup payload covering every section of the
  audit-retention surface in a single round-trip. Permission:
  `audit.view` (broad) — operators, DPOs, and compliance reviewers
  all need read access. The breach `notify` / `dismiss` actions on
  the page additionally require `breach_incident.manage`; the
  existing BS endpoints gate those calls.
- `ComplianceDashboardService.load(tenantId)` runs ~14 bounded
  queries inside a single `runInTenantContext` transaction (one
  GUC set, one connection):
  - Six retention-class rows with `total` + `pastFloor` counts so
    operators can spot misclassified rows / a stale BP sweeper.
  - Last 10 erasure requests with a `blockingClaimsCount` rollup
    + 90-day window completed/rejected counts.
  - Last 20 decrypt events with a join to `consent_record` so
    each row carries the bound consent's status (`granted` / `withdrawn`
    / `expired` / `superseded` / `unbound`). Withdrawn-but-still-
    referenced is informational, not a breach — it surfaces in the
    BU UI as an amber badge so DPOs can review.
  - Past-24h `unboundAccessCountLast24h` — count of decrypt events
    with `consentGrantId=null`. Engineering triage signal: callers
    that haven't been wired to BT's consent thread.
  - Breach incident counts per status + open-list ordered by
    `dpdpNotificationDueAt asc`, with `overdue=true` flag computed
    at read time when `dueAt < now`.
  - Consent counts per status + last 10 grant/withdraw rows
    ordered by `updatedAt desc` (so fresh withdrawals float
    alongside fresh grants).
- New web admin route `/admin/compliance` renders the payload as
  six sections: top-row count cards (open breaches, notified, active
  consents, unbound access), a red banner counting overdue breaches,
  retention-class table, open-breach table with **inline notify /
  dismiss buttons** (calls BS endpoints; window.prompt for the
  required dismiss reason), recent decrypt events with consent
  badges, recent erasures, recent consent changes. "Run breach
  scan" button hits BS's `POST /breach-incidents/scan` for
  on-demand sweeps without leaving the page.
- 5 e2e canary cases on `compliance-dashboard.e2e-spec.ts`:
  endpoint returns the full rollup with all six retention classes
  even when totals=0; an open breach with `dpdpNotificationDueAt`
  in the past is flagged `overdue=true`; bound vs unbound decrypt
  events report the right `consentStatus` + bump
  `unboundAccessCountLast24h`; reader without `audit.view` → 403;
  cross-tenant payload sees only the calling tenant's counts (RLS
  canary on every aggregation query).
- Closes the audit-retention axis. With BO–BU merged, Sprint 8
  is ready to exit — write `docs/sprint-8-exit.md` matching the
  prior sprint format when the user signals close.

### BT — DPDP §6 / Rule 8 consent record + access-ledger binding

- New `consent_record` table holds operator-captured DPDP consents.
  One row per `(patient, consentType)` grant lifecycle: a withdrawn
  / expired / superseded row sits alongside a later granted row;
  `findActiveFor` reads the most-recent `granted` row whose
  `expiresAt` is null or in the future. RLS = same-tenant SELECT /
  INSERT / UPDATE (status flips for withdrawal). DELETE blocked —
  consent records are themselves a compliance artifact and outlast
  the data they authorise. FK to `patient` is `ON DELETE NO
  ACTION` so a future BQ erasure scrubs the patient row in place
  without taking the consent record with it.
- Captured fields: `consentType` (`nhcx_processing` | `pmjay_processing`
  | `analytics` | `communication`), `dataCategories` + `purposes`
  JSON arrays, `lawfulBasis` (`consent` | `legitimate_use` |
  `legal_obligation` | `public_interest`), `source` (free-text
  channel descriptor), `evidence` JSON snapshot of the notice
  shown to the data principal at consent time, optional
  `expiresAt` and `documentId` (link to a stored paper-form
  scan), `capturedByUserId`, `withdrawnAt` + `withdrawalReason`
  on flip.
- New `ConsentService` with five operations:
  - `grant(input)` — create a row with status='granted'; verifies
    patient belongs to tenant; emits `CONSENT_GRANTED` audit row
    (consent retention class — held until withdrawal + statutory
    floor under Rule 8).
  - `withdraw(id, reason)` — flip granted → withdrawn with the
    required reason for §13 traceability; rejects when status
    isn't 'granted'; emits `CONSENT_WITHDRAWN` audit row.
  - `list(filter)` — tenant-scoped, optional filters on patient /
    type / status, ordered by `grantedAt desc`.
  - `findActiveFor(tenant, patient, type)` — returns the most-
    recent granted row covering the (patient, type) tuple; null
    when none exists.
  - `requireConsent(...)` — call-site guard; throws
    ValidationFailedError when no active grant exists. Service
    code gating PII reads (preauth / claim submit) calls this
    before decryption.
- **Access-ledger binding**: `data_access_event` gains a nullable
  `consentGrantId UUID` column. `DataAccessLogService` accepts it
  in the write input; `PatientService.getDecrypted` extends ctx
  with `consentGrantId`. Service callers (eligibility / preauth /
  claim submit slices in subsequent work) thread the active grant
  id from `findActiveFor` into the decrypt ctx, and the row's
  binding back to the consent grant lets BU's compliance dashboard
  answer "show every read authorised by this grant" with a single
  index lookup. Loose-coupled by uuid (no FK) so the ledger row
  outlives any future consent-record migration.
- New endpoints (`/consents`):
  - `POST /consents` — manage; capture a new grant.
  - `GET  /consents` — view; list with optional patient / type / status filters.
  - `GET  /consents/:id` — view; row.
  - `POST /consents/:id/withdraw` — manage; flip + reason.
- New permissions: `consent.view` + `consent.manage`. View is
  granted broadly (intake desks need to see whether a patient has
  consented before processing); manage is restricted to roles that
  capture consent at admission and the DPO who handles
  withdrawals. Default seed: `platform_admin` and `tenant_admin`
  get both; `billing_manager` and `insurance_desk_executive` get
  both (they're the operator-level roles capturing consent at
  intake); `pmam`, `doctor`, `finance_viewer`, `read_only` are
  intentionally excluded.
- New audit events: `CONSENT_GRANTED`, `CONSENT_WITHDRAWN` —
  classified as `consent` retention class (held until withdrawal
  + statutory floor; distinct from governance because the
  withdrawal of a consent is itself a data-principal right).
- New web admin route at `/admin/consents` mirrors the audit
  viewer pattern: filterable list (patient / type / status) with
  inline withdraw button (prompts for reason) for `granted` rows.
- 8 e2e canary cases on `consent-record.e2e-spec.ts`: grant lands
  status='granted'; list filters by patient + status; withdraw
  flips status with reason + rejects second withdraw (422);
  `requireConsent` throws when no grant + returns row when active;
  `findActiveFor` excludes expired (past `expiresAt`) and
  withdrawn rows; `PatientService.getDecrypted` threads
  `consentGrantId` into the resulting `data_access_event` row;
  reader without `consent.view` → 403; cross-tenant GET → 422
  (RLS canary).

### BS — DPDP §8(6) breach detection + 72h notification template

- New append-only-on-DELETE `breach_incident` table records both
  auto-detected anomalies and operator-filed manual reports. Status
  lifecycle (`detected → notified | dismissed`) is enforced by the
  service; RLS UPDATE policy permits same-tenant flips so the
  controller can mark notified / dismissed atomically. DELETE is
  blocked at the policy level — breach records are themselves a
  compliance artifact.
- Unique constraint on `(tenantId, kind, actorUserId, windowStart)`
  gives the detector idempotency: re-running the scan within the
  same minute boundary converges on the same row instead of
  duplicating. Manual reports leave `actorUserId` and `windowStart`
  null, naturally skipping the constraint (PG NULL ≠ NULL semantics
  in unique indexes).
- New `BreachDetectorService.scan()` — v1 heuristic is
  **BURST_DECRYPT**: for each `(tenantId, actorUserId)` seen in the
  `data_access_event` ledger over the past `windowMinutes`, count
  distinct patient resourceIds that were decrypted. If the count
  exceeds 50 (configurable via `BURST_DECRYPT_PATIENT_THRESHOLD`),
  open a `severity='high'` incident tagged with the union of
  `fieldNames` from the events. Distinct-patients (not raw event
  count) is the right signal: one operator triaging a complex case
  may legitimately decrypt the same patient many times; touching
  many patients quickly is the suspicious pattern. The detector
  runs platform-wide in one pass (platform_admin role for the
  SELECT) and inserts per-tenant under the tenant role for the
  INSERT — so the RLS INSERT policy still gates writes correctly.
- New `BreachIncidentService` with five operations:
  - `fileManual()` — operator-filed `kind='MANUAL_REPORT'` (lost
    laptop, vendor breach, anything the heuristic doesn't catch).
  - `openAutoWithTx(tx, ...)` — detector-driven insert; returns
    `null` on the unique-constraint conflict so re-runs are a no-op.
  - `list(input)` — tenant-scoped, optional filters on
    `status` / `kind` / `from` / `to`, ordered by `openedAt desc`.
  - `findById()` + `renderNotificationPreview()` — view + show the
    rendered template before notifying.
  - `notify()` — flip `detected → notified`, snapshot the §8(6)
    template into `dpdpNotificationPayload`, stamp
    `dpdpNotificationSentAt`. Rejects when status isn't `detected`.
  - `dismiss()` — flip `detected → dismissed` with a required
    `reason` (DPDP audit trail needs the reason a potential
    breach was deemed not-reportable). Rejects when status isn't
    `detected`.
- New DPDP §8(6) notification template renderer at
  `apps/api/src/modules/breach/dpdp-notification-template.ts`. Pure
  function: takes the incident + tenant context and produces a
  `{subject, body, fields}` payload covering all six required
  Schedule II elements (description, approximate count of data
  principals, categories of data, likely consequences, mitigation
  measures, grievance officer contact). `BURST_DECRYPT` and
  `MANUAL_REPORT` get different stock copy for the consequences /
  mitigations sections. The 72-hour deadline is centralised as
  `DPDP_NOTIFICATION_WINDOW_MS = 72 * 60 * 60 * 1000` so the
  service + dashboard read from one source.
- New endpoints (`/breach-incidents`):
  - `POST /breach-incidents/scan` — manage; trigger detector pass.
  - `POST /breach-incidents` — manage; manual file.
  - `GET  /breach-incidents` — view; list (filter by status / kind / date).
  - `GET  /breach-incidents/:id` — view; row + rendered preview when
    status='detected', or the snapshotted payload when notified.
  - `POST /breach-incidents/:id/notify` — manage; flip + snapshot.
  - `POST /breach-incidents/:id/dismiss` — manage; flip with reason.
- New permissions: `breach_incident.view` + `breach_incident.manage`.
  Both granted to `platform_admin` and `tenant_admin` seed roles by
  default. Other roles (billing manager, insurance desk, reader)
  are intentionally excluded — incident records expose actor
  identity and the categories of personal data implicated.
- New audit events: `BREACH_INCIDENT_OPENED`,
  `BREACH_INCIDENT_NOTIFIED`, `BREACH_INCIDENT_DISMISSED`,
  `BREACH_DETECTOR_SCAN_COMPLETED`. All classified as governance
  (`retentionClass='governance'`, 8-year floor) so the compliance
  trail outlasts the incidents themselves.
- New CLI: `pnpm --filter @claims/api breach:scan`. Same shape as
  `audit:retention-sweep` — boots the Nest app, runs one
  `BreachDetectorService.scan()` pass, prints the structured result
  to stdout, exits. Production wiring is an external scheduler
  (k8s CronJob, cloud cron, pg_cron) on a 10–15 minute cadence for
  tight detection or hourly for steady state. Optional
  `--window-minutes=N` flag overrides the default 60-minute lookback.
- 8 e2e canary cases on `breach-incident.e2e-spec.ts`: detector
  raises BURST_DECRYPT when threshold exceeded; idempotent on
  re-run within the same minute; manual file lands MANUAL_REPORT
  with 72h `dpdpNotificationDueAt`; preview renders all six §8(6)
  sections; notify flips status + captures payload + rejects
  second notify; dismiss flips status with reason + rejects
  subsequent notify; viewer with `breach_incident.view` only is
  read-only (file/notify/dismiss → 403); reader with no breach
  permission can't list (403); cross-tenant GET → 422 (RLS canary).
- 6 unit tests on `dpdp-notification-template.spec.ts` lock the
  72h constant, the six §8(6) sections, the placeholder fallback
  for missing grievance contact, the kind-specific consequences /
  mitigations copy, and the structured-fields ISO round-trip.

### BR — DPDP §17 data access ledger + interceptor

- New append-only `data_access_event` table records every read of
  personal data (decryption of an encrypted PII field, bulk view
  of a PII-bearing list, audit-log query). Distinct from
  `audit_log` (which records state changes); this ledger records
  reads. DPDP Rules 2025 require operators to be able to answer
  "show me every time this patient's data was accessed". Rows
  carry `actorUserId`, `actorType`, `resourceType`, `resourceId`,
  `action`, `purpose`, optional `fieldNames` JSON, plus IP / UA /
  correlationId. Append-only at the RLS level (no UPDATE / DELETE
  policies); same tenant-scoped SELECT pattern as audit_log.
- New `DataAccessLogService` mirrors `AuditService` shape with
  `record()` (opens its own platform_admin transaction) and
  `recordWithTx()` (writes inside a caller's tenant tx).
- Two recording paths:
  - **Service-level decryption hook**: `PatientService.getDecrypted`
    now records an `action='decrypt'` event with a `fieldNames`
    list of the encrypted columns that were actually populated
    (`['aadhaar', 'mobile', ...]`). Optional `ctx` arg threads
    `actorUserId` + `purpose` + `correlationId` from the calling
    service; missing context falls back to `purpose='unspecified'`
    so coverage isn't lost during incremental rollout. Recording
    is best-effort and fire-and-forget — log failures must never
    break a decryption that orchestrators depend on.
  - **HTTP interceptor**: `@LogsPiiAccess({resourceType, action,
    purpose})` decorator on a controller method tags the handler;
    `PiiAccessInterceptor` (registered as `APP_INTERCEPTOR`) reads
    the metadata after the handler resolves successfully and
    writes a row tagging the actor + IP + UA. We log only on
    success — failed reads are audit_log territory. Applied on
    `AuditController.list` (purpose `audit_query`) and
    `AuditController.export` (purpose `audit_export`).
- 5 e2e canary cases on `data-access-event.e2e-spec.ts`:
  GET /audit emits a list event with the right purpose, GET
  /audit/export.csv emits an export event, `getDecrypted` records
  a decrypt event with field names from the explicit ctx,
  `getDecrypted` without ctx falls back to `purpose='unspecified'`,
  cross-tenant SELECT under tenant A's context returns no rows
  whose actor belongs to tenant B (RLS canary).

### BQ — DPDP §11 erasure-on-request

- New `erasure_request` table + `POST /erasure-requests` endpoint
  for honouring data principal erasure requests under DPDP Act 2023
  §11. Tenant-scoped, append-only at the RLS level (no UPDATE /
  DELETE policies), so every request commits with its final
  outcome and can't be edited later.
- Two terminal outcomes:
  - `completed` — patient PII redacted in-place. Encrypted ciphers
    + key versions + lookup hashes nulled (Aadhaar / ABHA /
    mobile / email / policy-number); plaintext fields scrubbed
    (fullName → `REDACTED-{6-digit-suffix}`, dateOfBirth → null,
    gender → null). Linked Case rows get `patientName` +
    `hospitalMrn` replaced with the same placeholder. The patient
    + case rows themselves stay because the linked Claim records
    carry IRDAI 5y / RBI 10y retention obligations against the
    now-redacted personal data.
  - `rejected` — DPDP §13 carve-out applies because one or more
    claims are still in non-terminal status. The response payload
    includes `rejectionReason.blockingClaims` listing each
    `{id, status}` so the operator can come back when the
    blocking claims close. "Erasable" statuses are `CLOSED`,
    `ABANDONED`, `WRITTEN_OFF` — broader than the state-machine's
    `TERMINAL_STATUSES` (CLOSED + ABANDONED only) because
    WRITTEN_OFF is functionally terminal for DPDP purposes.
- New permission `Permissions.ERASURE_PROCESS` (`erasure.process`).
  Seeded onto the two tenant-admin roles that already had
  `audit.view` (tenant_admin + billing_manager). Other roles are
  blocked with HTTP 403.
- New audit events `ERASURE_REQUEST_PROCESSED` +
  `ERASURE_REQUEST_REJECTED`, both classified as `governance` so
  the compliance audit trail outlasts the redacted personal data
  it documents. The classifier coverage test added in BO catches
  unclassified events at PR-time.
- 6 e2e canary cases: reader without permission → 403, no-claims
  patient → completed + PII scrubbed (verified by reading the
  patient + case rows back), patient with active PREAUTH_QUEUED
  claim → rejected + blockingClaims list + no redaction performed,
  patient with CLOSED claim → completed (closed claims don't
  block), cross-tenant GET on someone else's request id → 422
  (RLS canary), unknown patientId → 422.

### BP — Audit retention sweeper

- Postgres function `audit_retention_sweep(p_class TEXT, p_floor_days INT) RETURNS INT`
  deletes rows where `retentionClass = p_class AND occurredAt < now() - p_floor_days days`,
  returns the count. Rejects non-positive `p_floor_days` and empty
  `p_class` with a clear `RAISE EXCEPTION` so a misconfigured caller
  trips a hard error instead of silently deleting nothing.
- New RLS policy `audit_log_delete_retention` allows DELETE only when
  `app_current_role() = 'retention_sweeper'`. The existing
  `audit_log_no_delete USING(false)` policy continues to block every
  other role; both policies OR together at the row level so `tenant`
  and `platform_admin` callers still cannot delete audit rows. The
  new privileged role is set transactionally via `set_config('app.role',
  'retention_sweeper', true)` and never persists outside the sweep.
- `AuditRetentionSweeperService.sweepAll()` flips the role, iterates
  all six retention classes via the Postgres function in a single
  transaction, sums per-class counts, and emits a self-audit row
  (`action=AUDIT_RETENTION_SWEEP_COMPLETED`,
  `retentionClass=governance`) with the per-class counts + duration
  in the JSON `after` field. The self-audit row uses the zero-UUID
  tenantId sentinel because the sweep is platform-scoped, not
  tenant-scoped.
- `TenantRole` extended to include `retention_sweeper` (alongside
  `tenant` and `platform_admin`) so the privileged role is a
  first-class type and can't be passed by typo from arbitrary
  callers.
- Operator triggering: new CLI script invoked via
  `pnpm --filter @claims/api audit:retention-sweep`. Boots the
  NestJS application context (no HTTP listener), runs `sweepAll()`,
  prints a JSON summary, and exits. Wire to k8s CronJob / cloud
  cron / pg_cron for nightly cadence. We deliberately don't ship an
  in-app `@Cron` decorator — Redis is deferred and a naive
  `setInterval` would race across replicas and over-delete.
- 4 e2e canary cases: sweep deletes past-floor rows in each class
  while preserving recent rows; self-audit row carries the per-class
  counts; calling the function under the wrong role (e.g. `platform_admin`)
  silently deletes 0 rows (RLS gate works); the function rejects
  invalid `p_floor_days <= 0` and empty `p_class`.
- Self-audit event `AUDIT_RETENTION_SWEEP_COMPLETED` added to the
  `AuditEvents` enum and explicitly classified as `governance`. The
  classifier coverage test from BO is what would catch a future
  audit event being added without classification.

### BO — `audit_log.retentionClass` column + classifier + backfill

- Adds a stable semantic label to every `audit_log` row so BP's
  sweeper, BQ's erasure-on-request consent check, and BU's
  compliance dashboard can read from one column instead of
  re-deriving from the action string. Six classes, naming
  semantic-not-numeric so the year mapping can change without a
  schema migration:
  - `financial`  — RBI 10y. Settlement / payment / lending /
    monetary-impact decisions. Default fallback for unmapped
    actions (conservative — keep longer).
  - `clinical`   — IRDAI 5y. Claim/preauth/discharge transitions,
    doctor signatures, FHIR exchanges.
  - `security`   — DPDP/IRDAI 3y. Failed logins, account lock /
    unlock, password resets, MFA changes.
  - `session`    — DPDP transit, 90d. Login / logout / session
    revoked.
  - `governance` — 8y. Tenant lifecycle, NHCX cert rotations,
    role grants, invitations, user lifecycle.
  - `consent`    — 8y after withdrawal (BT will refine). DPDP
    consent records.
- New TS classifier at
  `apps/api/src/modules/audit/retention-classes.ts` maps every
  defined `AuditEvent` to a class. Coverage test asserts no
  current event silently hits the FINANCIAL fallback — adding a
  new event is a hard-fail on the spec until classified.
- Centralised `RETENTION_FLOOR_DAYS` map: `financial=3650`,
  `clinical=1825`, `security=1095`, `session=90`,
  `governance=2920`, `consent=2920`. BP reads from this; if
  DigiSparsh-lending slips out of v1, only this map needs to
  change to collapse `financial` to IRDAI 5y.
- Migration `20260524000000_audit_retention_class` adds the
  column with `NOT NULL DEFAULT 'financial'`, backfills existing
  rows by mapping action → class (mirrors the TS classifier),
  and adds a `(retentionClass, occurredAt)` index for BP's
  sweeper.
- `AuditService.recordWithTx` calls the classifier on every new
  write so the column is stamped at insert time.
- 21 unit cases on the classifier + taxonomy invariants
  (financial = longest, session = 90d, clinical = IRDAI 5y, etc.)
  + a 6-case e2e canary that asserts the column is stamped
  per-event by the service path AND the column-default kicks in
  for raw inserts skipping the column AND no fresh-DB row has a
  null/empty retentionClass.

## Sprint 7 — TBD (May 2026)

Theme settled mid-sprint: **PMJAY-via-NHCX is in v1**. Discovery
that PMJAY is migrating onto the same HCX 0.7.1 protocol surface we
already implemented (vs. the older "portal automation" framing in
`docs/07`) collapses the PMJAY sub-project from 4–8 weeks to ~8
slices. The v1 Sprint 7 axis runs PMJAY (BF–BM) + the EOB-OCR
inference service (separate Python repo) + earlier hardening
(BE deep-readiness already shipped). OVH KMS + Redis remain
deferred to production-rollout config swaps.

### BF — ABDM biometric authentication adapter

- New module `biometric-auth/` mirroring the EOB-OCR adapter pattern
  (off / stub / real factory). PMJAY mandates Aadhaar biometric
  / face / iris verification before preauth and before discharge or
  claim submission; this slice ships the adapter only — Slice BG
  will gate preauth + claim submit on it for PMJAY-mode tenants.
- Three adapters bound by `BIOMETRIC_AUTH_MODE`:
  - `off` (default) — `DisabledBiometricAuthAdapter`. Every call
    returns `{ status: 'disabled' }`. Non-PMJAY tenants and dev /
    test deployments take this path.
  - `stub` — `StubBiometricAuthAdapter`. Deterministic in-process
    pass with an env-driven failure list
    (`BIOMETRIC_AUTH_STUB_FAIL_LIST`) for negative-path tests.
    txnId / authToken / refreshToken issuance mimics the
    observable ABDM behaviour without an ABDM sandbox account.
  - `real` — `HttpBiometricAuthAdapter`. POSTs to
    `<BIOMETRIC_AUTH_BASE_URL>/hcx/abha/biometric/auth/{init,
    verify}`, GETs `/refresh/token`. Required headers
    (`authorization`, `process: Preauth | Discharge`,
    `payerid`) per the documented contract. Defensive parsing on
    every response so a sloppy upstream can't poison the gate.
- New env vars: `BIOMETRIC_AUTH_MODE` (off | stub | real, default
  off), `BIOMETRIC_AUTH_BASE_URL` (required when real),
  `BIOMETRIC_AUTH_HTTP_TIMEOUT_MS` (default 15s),
  `BIOMETRIC_AUTH_STUB_FAIL_LIST`. Boot-time config check rejects
  `real` mode without `BIOMETRIC_AUTH_BASE_URL` so a production
  deploy can't silently fall back to "every verify fails".
- 8 unit tests on the disabled + stub adapters cover happy path,
  fail-list rejection, replay protection, all three auth modes
  (FINGERPRINT / FACE_AUTH / IRIS), and refresh-token issuance.
  12 unit tests on the HTTP adapter against a `node:http` mock
  ABDM cover request shape (URLs, headers, JSON body), the
  one-PID-block-per-mode invariant, missing-`txnId` and
  missing-`token` paths, HTTP 401 / 500 errors, and connection
  refused.

### BN — PMJAY participant onboarding CLI

- One-shot per-hospital CLI at
  `apps/api/src/scripts/pmjay-onboard/`. Drives the four-step PMJAY
  participant flow:
  1. `participant/create` → SMS OTP issued.
  2. `validate?transactionId&passcode` → status PENDING → ACTIVE.
  3. `participant/update` (with public key + endpoint URL) → new
     SMS OTP, 24h TTL.
  4. `update/validate?transactionId&passcode` → certificate
     registered, endpoint live, status fully ACTIVE.
- State (participantid + both transactionids + key paths) persists
  to a JSON file the operator passes via `--state-file`. The
  step-3 OTP can land 24 hours later, so resume between runs is a
  first-class flow: `--resume` re-enters the saved step. State
  written with mode 0600 on POSIX (best-effort no-op on Windows).
- Generates a 2048-bit RSA keypair locally if one isn't already at
  the configured path prefix (writes `*.private.pem` 0600 +
  `*.public.pem` 0644). Public key is base64(pem-text) for
  `encryptioncert`. Refuses to clobber a single pre-existing file
  to protect operator-generated keys.
- Run via `pnpm --filter @claims/api pmjay:onboard --base-url
  https://apisbx.abdm.gov.in/pmjay/sbxhcx/participanthcxservice/v2/`
  and similar for production. All inputs (registry id, mobile,
  email, endpoint URL) are prompted interactively; flags supply
  them non-interactively for scripted runs.
- Three test files (20 total cases): HTTP client coverage on URL
  composition, bearer header, query-param encoding for OTP
  validates, Zod input validation, error envelope handling, and
  non-JSON response capture; state file round-trip + corruption
  rejection + resume; keypair generation, idempotency on existing
  files, refusal to clobber a half-existing pair, and base64-PEM
  serialisation.
- Source contract: `HIMS-PMJAY suppporting docs/PMJAY Hospital
  Migration to HMIS via NHCX.docx` §3.1–3.4 (authoritative payload
  shapes), `NHCX-PMJAY-HMIS Integration Guide (1).pdf` §1.7
  (sandbox prerequisites), `NHCX PMJAY Integration Handbook.docx`
  §5.5.2 (host pattern). After step 4, the operator must raise an
  NHA ticket to map PMJAY Hospital ID (HEM ID) ↔ NHCX Participant
  ID — that's the manual go-live trigger and is out of scope for
  the CLI.

### BM — FHIR code-system whitelist (PMJAY-aware)

- New pure validator at `apps/api/src/modules/nhcx/fhir-validator/`.
  Walks an inbound (or outbound) FHIR Bundle, collects every unique
  `coding.system` and `identifier.system` URI, and classifies them
  against four buckets:
  - `universal` — HL7 / FHIR R4 terminology shared across rails
    (e.g. `terminology.hl7.org/CodeSystem/v2-0203`,
    `hl7.org/fhir/sid/icd-10`).
  - `nhcx` — ABDM + NDHM core registries (HPR, ABHA, facility) plus
    DigiSparsh-internal identifiers (`urn:digisparsh:*`).
  - `pmjay` — PMJAY-specific systems documented in
    `HIMS-PMJAY suppporting docs/FHIR_bundles_PMJAY_ext/`:
    `payer.pmjay.nha.gov.in` (package + diagnosis codes),
    `payer.pmjay.nha.gov.in/CodeSystem/task-{operation,reason}`
    (Slices BH/BI), `hcx.pmjay.gov.in/v1/{coverageeligibility/check,
    preauthorization, claim}`, `bis.pmjay.gov.in`,
    `provider.pmjay.gov.in`, `payer.nha.gov.in`,
    `nhcx.pmjay.gov.in`.
  - `unknown` — anything not in the above three sets.
- Identifier-type code detection: under
  `nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-identifier-type-code`, we
  recognise `PMJAY`, `HPID`, `HPIN`, `JHN`, `PI`, `NPI`, `NIIP`,
  `NH`. The validator surfaces a `usesPmjayIdentifierType` boolean
  for cross-checks and lists any unknown codes under that system.
- Wired into `NhcxInboundService.process()` after JWE decryption.
  When the validator finds anything (unknown systems, unknown
  identifier-type codes, or PMJAY systems on a non-PMJAY-mode
  tenant — likely a misrouted callback), the dispatcher emits a
  structured warning carrying correlationId + tenantId. Non-blocking
  in v1: the gateway evolves faster than our whitelist could, and
  rejecting callbacks would hold up legitimate traffic. The
  signal is for ops triage.
- 10 unit cases on the validator: standard NHCX bundle classifies
  cleanly with no unknowns, real-shape PMJAY bundle (mirroring
  `coveragerequest_benefits.txt` from the supporting docs) hits
  all three whitelist buckets and detects the PMJAY identifier
  type, unknown payer systems land in `unknown`, unknown
  identifier-type codes under the NDHM system surface, codes under
  non-NDHM systems are NOT mis-classified, non-object inputs
  return empty results, and `summariseFindings` returns null on
  the happy path / surfaces misroute warning / lists unknowns.

### BL — PMJAY drop Communication-based query response (re-submit instead)

- PMJAY tenants don't respond to payer queries via FHIR Communication;
  the documented workflow is to pull the preauth (or claim) back to
  drafting, fix whatever the payer asked about, and re-submit. We
  reject the existing Communication-based response endpoint for PMJAY
  callers with HTTP 422 and a tenant-field error that points the
  operator at the new resubmit route.
- Two new endpoints, both PMJAY-only at the service gate:
  - `POST /cases/:caseId/claims/:claimId/preauth/resubmit` — flips
    `PREAUTH_QUERY_RAISED → preauth.resubmission_started → PREAUTH_DRAFTING`
    via a new state-machine transition. Outstanding `preauth_query`
    rows on the claim are stamped with `responseText='[resubmit] ...'`
    and `respondedAt=now()` so the audit trail captures *why* the
    operator pulled back to drafting (informational; the state
    transition is what closes the query window).
  - `POST /cases/:caseId/claims/:claimId/claim-submission/resubmit`
    — mirror of the preauth flow on the claim side. Flips
    `CLAIM_QUERY_RAISED → claim.resubmission_started → CLAIM_DRAFTING`.
- Both routes are state-only flips — no NHCX outbound. The next
  `preauth/submit` (or `claim-submission/submit`) is what reaches
  the gateway.
- New permissions / events:
  - `Permissions.CLAIM_RESPOND_QUERY` (mirror of the existing
    `PREAUTH_RESPOND_QUERY`) for the claim resubmit route. Seeded
    onto the four PMJAY-active roles in `prisma/seed.ts`. The
    preauth resubmit route reuses `PREAUTH_RESPOND_QUERY` because
    it's a query-resolution gesture.
  - Two new claim events: `preauth.resubmission_started`,
    `claim.resubmission_started`. New transitions are
    `from`-restricted to the QUERY_RAISED states; the state-machine
    spec asserts non-QUERY_RAISED inputs are refused.
- 4 unit cases added to `claim.state-machine.spec.ts` covering the
  new transitions + their refusal from non-QUERY_RAISED states.
  6 e2e cases on `pmjay-resubmit-on-query.e2e-spec.ts`: PMJAY
  Communication-respond rejected, PMJAY preauth resubmit happy path
  (with `preauth_query` stamp assertion), non-PMJAY preauth resubmit
  rejected, PMJAY claim resubmit happy path, non-PMJAY claim
  resubmit rejected, PMJAY resubmit from non-QUERY_RAISED → 422.

### BK — PMJAY eligibility three-purpose dispatch

- PMJAY-via-NHCX runs `coverageeligibility/check` three times per
  case, each with a different FHIR `CoverageEligibilityRequest.purpose`
  value: `validation` (post-registration / wallet check),
  `benefits` (before preauth, to confirm coverage limits), and
  `auth-requirements` (before submission, to fetch the document
  checklist). Reference bundles are in
  `HIMS-PMJAY suppporting docs/FHIR_bundles_PMJAY_ext/coverageeligibility/`.
- New `purpose` field on `EligibilityRequestSchema` (zod enum:
  `validation | benefits | auth-requirements`). Optional at the
  schema level for backwards-compatibility with the existing private-
  rail callers, but **required for PMJAY tenants** — the eligibility
  service rejects a missing purpose with HTTP 422 when
  `tenant.pmjayMode === 'on'`.
- `buildEligibilityRequestBundle` now accepts a single-element
  purpose; when set it emits `purpose: [purpose]`, when omitted it
  falls back to the legacy combined `['benefits', 'validation']`.
  Adapter interface gains `AdapterEligibilityPurpose` +
  `purpose?: ...` on `AdapterEligibilityRequest`. Stub adapter
  echoes purpose into the inbound `rawResponse` so integration
  tests can assert the correct dispatch landed. JWE adapter
  forwards purpose to the builder.
- New eligibility request payload field is the only API surface
  change. No new permission, no migration. The PMJAY purpose is
  also stamped on the `eligibility.requested` claim event payload
  so the audit ledger distinguishes the three calls.
- 4 unit tests on the FHIR builder verify the four purpose
  variants (legacy + 3 single-purpose values). 6 e2e cases on
  `/cases/:caseId/claims/:claimId/eligibility`: PMJAY missing
  purpose → 422 with field-targeted error from the gate, PMJAY
  with each of the three purposes → 200 + ledger echo, PMJAY
  with a bogus purpose value (FHIR `discovery`, not in our enum)
  → 422 from Zod, non-PMJAY tenant + omitted purpose → 200
  legacy path with no purpose echo.

### BJ — PMJAY beneficiary policies lookup (`/participant/get/policies`)

- New endpoint `POST /pmjay/policies/lookup` — pre-eligibility step
  where the operator enters an ABHA / mobile and the API returns
  the matching PMJAY policies the beneficiary is enrolled in. The
  operator picks one to attach to the case before running
  eligibility.
- Identifier types per the PMJAY supporting docs: ABHA (14 digits,
  no hyphens) and mobile (10 digits). Aadhaar is intentionally NOT
  supported — PMJAY's API requires ABHA / mobile linkage at
  registration; the docs are silent on Aadhaar.
- Per-policy fields sourced from NHCX PMJAY Integration Handbook
  §5.6: `payerId`, `memberId`, `productId`, `productName`,
  `policyNumber`. Optional fields like `sumInsured`, `state`,
  `status` aren't documented and aren't surfaced by the adapter
  yet — extend defensively when the upstream response is observed.
- New `NhcxAdapter.lookupPmjayPolicies` on the interface + stub.
  JWE real-mode is **deferred**: the upstream sandbox/prod URL for
  `/participant/get/policies` isn't published in the supporting
  docs, and per §5.6 this endpoint is plain-REST + bearer-auth
  (NOT JWE-wrapped) so it doesn't fit `callOperation`'s envelope.
  JWE adapter throws a clear "real-mode not yet implemented" error
  pointing at the §5.6 reference; ops must run `NHCX_MODE=stub`
  for now.
- Stub adapter: deterministic fixtures keyed off the identifier:
  - non-sentinel → one PMJAY Rajasthan policy with values derived
    from the last 6 chars of the identifier
  - `STUB-EMPTY-*` → empty `policies` array (beneficiary not linked)
  - `STUB-MULTI-*` → two policies on different products
- New module `pmjay-policies/` with thin `PmjayPoliciesService`
  (tenant gate → adapter pass-through; no persistence). PMJAY-only
  — non-PMJAY tenants get 422 `tenant: ['PMJAY policies lookup is
  currently a PMJAY-only operation.']`.
- Permission: reuses `PREAUTH_DRAFT` rather than introducing a new
  permission. Every operator who can start a preauth needs to be
  able to look up the beneficiary's policy; a dedicated permission
  is a future split if the desks separate.
- Tests:
  - 4 unit cases on the stub adapter (single, empty, multi, echo)
  - 3 unit cases on `PmjayPoliciesService` (PMJAY pass-through,
    non-PMJAY rejection, unknown-tenant rejection)
  - 5 e2e cases: PMJAY ABHA lookup, mobile lookup, non-PMJAY
    rejection, malformed ABHA → 422 from Zod, malformed mobile →
    422 from Zod

### BI — PMJAY claim reprocess (CRC) via outbound `task/submit`

- Mirror of Slice BH on the claim side: outbound `task/submit` with
  PMJAY's `code: 'reprocess'` shape, used for the Claim Re-Consideration
  flow. Two reason codes per the PMJAY supporting docs:
  `claimrejected` (re-evaluate a CLAIM_REJECTED claim) and
  `partialpayment` (re-evaluate a SHORT_PAID settlement).
- New `NhcxAdapter.reprocessClaim` on the interface + stub + JWE.
- New `buildTaskReprocessBundle` FHIR builder with two
  `Task.input[]` entries: ClaimNumber → claimRefNum, plus a
  ReasonCode coding on the PMJAY task-reason code system.
  `Task.status='requested'` (vs cancel's 'cancelled') because the
  hospital is asking the payer to act, not asserting a state on
  their behalf.
- New `CLAIM_REPROCESS_REQUESTED` status + `claim.reprocess_requested`
  event. Transitions:
  - `CLAIM_REJECTED → claim.reprocess_requested → CLAIM_REPROCESS_REQUESTED`
  - `SHORT_PAID → claim.reprocess_requested → CLAIM_REPROCESS_REQUESTED`
  - From CLAIM_REPROCESS_REQUESTED, the existing decision events
    (claim.approved / .rejected / .partially_approved /
    .query_received) re-decide via the inbound `claim/on_submit`
    dispatcher.
- New `CLAIM_REPROCESS` permission + seed update — granted to
  every role that already has `claim.submit` (tenant_admin,
  billing_manager, insurance_desk_executive, pmam).
- New endpoint
  `POST /cases/:caseId/claims/:claimId/claim-submission/reprocess`
  with body `{ reasonCode: 'claimrejected' | 'partialpayment',
  reason?: string }`. Returns `{ status, correlationId }`. Service
  guards:
  - Tenant must be `pmjayMode='on'` → 422
    `tenant: ['Claim reprocess is currently a PMJAY-only operation.']`
  - Claim must have a `claimRefNum` → 422
    `claimRefNum: ['Reprocess requires a claim reference issued
    by the payer.']`
  - reasonCode/status must align: `claimrejected` requires
    CLAIM_REJECTED; `partialpayment` requires SHORT_PAID. → 422
    with field-targeted message naming the current status.
- Tests:
  - 5 new unit cases on `buildTaskReprocessBundle` (bundle shape,
    Task.status='requested' + code, two-input invariant
    [ClaimNumber + ReasonCode], reason display strings, note flow).
  - 3 e2e cases: PMJAY happy-path reprocess from CLAIM_REJECTED
    (walks the full preauth → discharge → claim flow with BG
    biometric), non-PMJAY rejection at tenant gate,
    reasonCode/status mismatch rejection.

### BH — PMJAY preauth cancel via outbound `task/submit`

- New `cancelPreauth` method on `NhcxAdapter` (stub + JWE) for the
  PMJAY-specific `task/submit` outbound with `code: 'cancel'` and
  `inputType: 'ClaimNumber'`. Hospital-asserted cancellation; the
  payer's ack arrives later via the existing `task/on_submit`
  inbound handler (Slice BD already records that branch).
- New FHIR `Task` bundle builder (`buildTaskCancelBundle`)
  materialises the wire shape per the PMJAY supporting docs:
  `Task.status='cancelled'`, `Task.code` carries the cancel coding
  on the PMJAY task-operation code system,
  `Task.input[]` carries `(ClaimNumber, preauthRefNum)`, optional
  operator reason flows into `Task.note[].text` for the payer's
  audit trail.
- New `PREAUTH_CANCELLED` status + `preauth.cancelled` event +
  transitions from `PREAUTH_QUEUED`, `PREAUTH_SUBMITTED`,
  `PREAUTH_QUERY_RAISED`, `PREAUTH_QUERY_RESPONDED`. Terminal-ish:
  only further transition is `case.abandoned → ABANDONED`.
- New `PREAUTH_CANCEL` permission + seed update — granted to
  `tenant_admin`, `billing_manager`, `insurance_desk_executive`,
  and `pmam` roles (every role with `preauth.submit`).
- New endpoint `POST /cases/:caseId/claims/:claimId/preauth/cancel`
  with Zod-validated `{ reason?: string }` body. Returns
  `{ status, correlationId }`. Service-level guards:
  - Tenant must be `pmjayMode='on'` — otherwise 422 with
    `tenant: ['Preauth cancel is currently a PMJAY-only operation.']`.
    PMJAY-only because the operation is part of the PMJAY API
    surface; non-PMJAY tenants don't have defined cancel semantics
    in HCX 0.7.1 yet.
  - Claim must have a `preauthRefNum` (the gateway-issued reference
    used as `Task.input[].valueIdentifier.value`) — otherwise 422
    with `preauthRefNum: ['Cancel requires a preauth reference
    issued by the payer.']`.
- Tests:
  - 5 new unit cases on `buildTaskCancelBundle`: bundle shape, Task
    status + code, input ClaimNumber wiring, reason → note,
    note omission when reason undefined.
  - 3 e2e cases: PMJAY happy-path cancel from PREAUTH_SUBMITTED
    (uses BG biometric flow + BF stub), non-PMJAY rejection at the
    tenant gate, no-preauthRefNum rejection.

### BG — PMJAY biometric gate on preauth + claim submit

- New `tenant.pmjayMode` column (`'on' | 'off'`, default `'off'`).
  Tenants in PMJAY-mode are gated on a recent ABDM biometric
  verification before preauth submit (process `Preauth`) and before
  claim submit (process `Discharge`). Non-PMJAY tenants are
  unaffected — no gate, no extra latency.
- New `biometric_verification` table records each successful ABDM
  verification with the originating ABDM `txnId`, hashed `loginId`
  (sha256 — raw ABHA / Aadhaar / mobile is never persisted),
  `process`, `authMode`, and a verifiedAt + expiresAt window
  (`BIOMETRIC_VERIFICATION_TTL_MINUTES`, default 60). Same
  RLS pattern as `appeal` and other tenant-scoped tables.
- New endpoints under `cases/:caseId/biometric-auth/`:
  - `POST /init` — proxies the ABDM `init` call, returns the
    `txnId` for the verify step. Doesn't write a row.
  - `POST /verify` — proxies `verify`, persists a row on
    success, enforces "exactly one PID block per authMode" before
    calling the adapter (saves a network round-trip on operator
    miswiring).
- New `BiometricAuthService.assertVerifiedFor(caseId, process)`
  helper invoked from `PreauthService.submit` and
  `ClaimSubmitService.submit` only when `tenant.pmjayMode === 'on'`.
  Throws `BiometricVerificationRequiredError` (HTTP 412 →
  `BIOMETRIC_VERIFICATION_REQUIRED`) when no non-expired row
  matches the `(caseId, process)` pair. Frontend bounces the
  operator to capture biometric and retry.
- Two new error codes: `BIOMETRIC_VERIFICATION_REQUIRED` (412 — gate
  miss) and `BIOMETRIC_VERIFICATION_FAILED` (422 — adapter
  rejected the device PID, network error, etc.). Both wired into
  `ErrorPresentations` with operator-friendly modal copy.
- 5-case end-to-end integration test:
  1. Non-PMJAY tenant submits preauth without biometric → 200
     (regression — gate must be invisible to non-PMJAY tenants).
  2. PMJAY tenant submits preauth without biometric → 412.
  3. PMJAY tenant: init → verify writes row → submit → 200.
  4. Verify rejects authMode/PID mismatch → 422.
  5. Init surfaces stub adapter failure → 422.
- We deliberately do NOT store the ABHA `authToken` /
  `refreshToken` in this slice — BG only needs the gate. Encrypted
  token storage + FHIR Bundle binding lands in a follow-up slice.

### BE — `/health/ready/deep` deep-readiness probe

- New endpoint `GET /health/ready/deep` extends the cheap `/ready`
  shape with a `deep` block that runs adapter-level probes against
  ClamAV (clamd zPING/PONG over TCP) and the EOB-OCR inference
  service (HEAD over HTTP). Each probe returns
  `{ status: 'ok' | 'skipped' | 'failed', reason?, latencyMs? }`.
- Probes run in parallel under a 2s ceiling each so the response
  stays bounded even when one dependency is wedged. `skipped` is
  the right answer for dev/test deployments where the adapter is
  in `off` or `stub` mode — we don't want a degraded LB drain
  because clamd isn't deployed locally.
- Overall `status` collapses to `degraded` if either the cheap
  `/ready` was already degraded *or* a deep probe failed, so
  ops dashboards get one signal to watch.
- Don't wire this onto the load balancer's probe path —
  `/ready` stays the cheap one. `/ready/deep` is for ops
  dashboards + manual-triggered diagnostics.
- 10 unit tests against `node:net` mock clamd + `node:http`
  mock OCR servers cover off/skip, real+healthy, abrupt close,
  missing endpoint, connection refused, alive 4xx (405 from
  inference services on HEAD `/` is treated as alive), 503
  failure, missing URL, both-parallel-ok.

## Sprint 6 — TBD (May 2026)

Theme not yet committed; sprint axis pending the user's call (see
`docs/sprint-5-exit.md` open questions). First slice is a follow-on
to the AO signature guard from Sprint 5.

### BD — `insuranceplan/on_request` + `task/on_submit` inbound types (PR #63)

- Completes the HCX 0.7.1 inbound protocol surface. The Sprint 4
  exit doc deferred these on the basis of "no operational
  pressure"; BD records them in the integration_message ledger so
  CLAUDE.md hard-rule #7 (every external integration call writes
  both directions) is fully satisfied. State transitions stay
  out of scope until the ops use cases are real.
- New `parseInsurancePlan` extracts `{ planId?, name?, status?,
  type? }` defensively — pulls the first non-empty
  `identifier[].value`, the FHIR-canonical `type[0].coding[0].code`,
  status pass-through.
- New `parseTask` extracts `{ status?, description?, focusRef? }`.
  `focusRef` reads `focus.reference` first, falls back to
  `focus.identifier.value`.
- Inbound dispatcher branches are log-only: parse, log a one-line
  ops summary, attach the parsed shape to the integration_message
  `rawResponse` summary. No claim service touched.
- 8 unit tests cover happy + missing-field + missing-resource +
  identifier-list fallback shapes for both parsers.
- 2 integration tests against an in-process JWE confirm: end-to-
  end accept + parse + record succeeded, no claim status change.

### BC — `paymentnotice/request` inbound handler (PR #62)

- New NHCX inbound message type. The gateway pushes a
  PaymentNotice when the payer settles a previously-submitted
  claim; the dispatcher routes it through
  `SettlementService.recordReceipt` so the claim auto-flips to
  PAYMENT_RECEIVED (or SHORT_PAID) without operator action.
- `paymentnotice/request` added to `NhcxInboundOperationSchema`.
  Tenant + claim resolution reuses the existing matching-outbound
  pattern (the gateway echoes the original `claim/on_submit`
  correlationId), so no cross-tenant lookup is needed.
- New `parsePaymentNotice` FHIR helper extracts
  `{ kind, receivedAmount, receivedAt?, bankTxnId?, claimRefNum? }`
  defensively. `bankTxnId` reads from either the top-level
  `identifier` (Mediassist / Star) or the nested
  `request.identifier` (Paramount). Cancelled / unknown notices
  log + skip without driving a transition.
- `RecordReceiptInput.actorUserId` is now `string | null` —
  matches the existing `claim_event.actorUserId` nullability so
  gateway-driven calls write a row with no operator attached.
  All existing operator-triggered call sites pass a string and
  type-check unchanged.
- 8 unit tests on the parser + 3 integration tests against an
  in-process JWE: full payment → PAYMENT_RECEIVED + bankTxnId
  on Settlement; short payment → SHORT_PAID; cancelled notice
  recorded but no transition driven.

### BB — Reconcile UI with deduction lines (PR #61)

- Reconcile branch on `PAYMENT_RECEIVED` was a single "Reconcile
  (auto-match)" button with no way to capture the structured
  deduction lines the API has accepted since Slice N. BB exposes
  an Add line button that stamps a `{ category, amount, reason }`
  row, with Remove next to each line.
- Auto-fill from the AY EOB extraction. When the operator runs
  Extract earlier (typically at `PAYMENT_PENDING`), any
  deductions in the result land in component state and pre-fill
  the rows once the claim transitions to `PAYMENT_RECEIVED`.
  The component stays mounted across the status change, so the
  state carries through without a fetch round-trip.
- Empty rows are dropped at submit (the operator can leave a
  half-edited row without sending an empty `{ category: '',
  amount: 0 }` to the API).
- Operator copy for the no-deductions case clarifies the auto-
  match semantics: reconciling with an empty deductions array
  records the payment as fully received.
- New `DeductionRow` helper component split out of the panel for
  the editable line; `ExtractSummary` is unchanged.

### BA — Settlement screen: extract-and-apply polish (PR #60)

- AY pre-filled `receivedAmount`. BA extends to `bankTxnId` and
  `shortPaymentReasons` so the operator can apply the full set of
  receipt-relevant fields the OCR found, not just the headline
  amount. The receipt form on `PAYMENT_PENDING` now exposes those
  three fields in a labelled grid; comma-split happens at submit
  so the operator can edit the list inline.
- AZ's download URL is wired into the EOB dropdown as a **View**
  button. Clicking it fetches a fresh presigned URL and opens the
  document in a new tab — operators can verify what the OCR is
  reading off without leaving the settlement screen.
- New `CaseApi.getDocumentDownloadUrl(caseId, claimId, documentId,
  filename?)` web client helper. Each call gets a fresh URL
  (presign expiry is short by design).
- `recordReceipt` call now forwards `bankTxnId` and
  `shortPaymentReasons` whenever they're non-empty; `bankTxnId`
  lands on the `Settlement` row (Slice AN persistence) so finance
  can reconcile back to the bank.

### AZ — Presigned document download URL (PR #59)

- New `GET /cases/:c/claims/:cl/documents/:id/download-url` returns
  a short-lived presigned GET URL the browser hits direct from S3.
  Operators can finally view what they uploaded — pre-req for the
  AY EOB-extract UX (you have to trust what the OCR is reading).
- `StorageAdapter` gains `presignDownload({ bucket, key,
  downloadFilename? })`. S3 impl uses `GetObjectCommand` +
  `ResponseContentDisposition` so the optional override binds to
  the SigV4 signature (a tampered URL won't change the
  download-as filename). Stub mode synthesises a `stub://` URL —
  tests use it to confirm wire-up without standing up MinIO.
- Same scope guards as the AW eob-extract endpoint: document
  belongs to (tenant, claim), upload completed, scan clean/skipped.
  Anything else 422 — we don't hand out URLs to infected or
  pending uploads. RBAC is `case.view` (anyone who can see the
  case can download its documents).
- `?filename=` query override sanitises CR/LF/`"` (the Content-
  Disposition quoted-string set) but lets unicode pass through.
- 3 integration tests against the stub storage path: happy path
  returns `stub://`, cross-claim → 422, filename override
  doesn't crash the request. Plus a stub-storage unit test for
  the URL synthesis.

### AY — EOB extract on the settlement screen (PR #58)

- Wires the AW endpoint into `SettlementPanel.tsx`. When the claim
  is at `PAYMENT_PENDING`, the panel now lists the claim's
  EOB-typed completed documents in a dropdown, exposes an
  "Extract" button, and pre-fills `receivedAmount` from the
  result.
- A coloured `ExtractSummary` block under the dropdown surfaces
  the extraction status (`extracted` / `low_confidence` / `failed`
  / `skipped`), the engine, and a deconstructed view of the
  fields (claimRefNum, receivedAmount, deductionAmount, bankTxnId,
  deductions) so the operator can sanity-check before clicking
  Record receipt.
- New `CaseApi.eobExtract(caseId, claimId, documentId, body)`
  client helper. Body is optional; the inline-buffer path is for
  the eventual operator UX where they re-attach the EOB on the
  fly. Default flow expects the API to fetch from S3 (real
  storage) — under stub storage the response surfaces as
  `skipped` and the operator types the values manually, exactly
  as before.
- No new tests at the web layer; the contract path is already
  covered by AW's API integration tests + AV's adapter unit tests.

### AX — Real EOB OCR adapter via HTTP inference service (PR #57)

- Closes the `EOB_OCR_MODE='real'` placeholder. The new
  `HttpEobOcrAdapter` POSTs document bytes as `multipart/form-data`
  to `<EOB_OCR_INFERENCE_URL>/extract` with optional bearer auth
  and parses the JSON response into the existing `ExtractResult`
  contract.
- The inference service is third-party from our perspective —
  any service that accepts `(file, contentType, filename)` as
  multipart and returns `{ status, engine, fields?, error? }`
  works. The reference implementation is a Python service wrapping
  PaddleOCR / Surya for OCR + Qwen2-VL / GOT-OCR2.0 for the
  structured-fields pass; the contract is compatible with custom
  per-tenant or per-payer extractors operators may stand up.
- Defensive response parsing — sloppy upstream output (wrong
  status, missing fields, bad numeric coercion) surfaces as
  `failed` rather than poisoning downstream persistence. Each
  field is type-checked individually; nothing flows through
  unvalidated.
- Storage-streaming path mirrors `ClamAvScanAdapter` (Slice AS):
  when only `(bucket, key)` is supplied, the adapter pulls bytes
  via `StorageAdapter.getObject`. Stub storage throws — caller
  sees `failed` with a clear "Failed to fetch object" reason.
- Boot-time config gate: `EOB_OCR_MODE=real` requires
  `EOB_OCR_INFERENCE_URL`. `EOB_OCR_HTTP_TIMEOUT_MS` defaults to
  60s (local Qwen2-VL on CPU can run ~10–30s per page). Optional
  `EOB_OCR_API_KEY` for self-hosted setups behind bearer auth.
- 12 unit tests against a `node:http` mock server cover request
  shape (POST /extract, multipart body, bearer header, body
  bytes embedded), happy paths (`extracted` / `low_confidence`),
  failure modes (non-2xx, malformed JSON, invalid status,
  missing fields, timeout, missing config, connection refused),
  trailing-slash stripping, and the AS-style storage-fetch path
  with both success and getObject-throws cases.

### AW — `POST /documents/:id/eob-extract` endpoint (PR #56)

- Wires the AV `EobOcrAdapter` to an HTTP surface so the settlement
  screen can pull extracted fields on demand. Lives at
  `POST /cases/:caseId/claims/:claimId/documents/:documentId/eob-extract`,
  scoped under the existing case/claim path so RBAC reuses
  `case.create` (the role that uploaded the EOB extracts its
  fields).
- `bufferBase64` request field is optional. Provided: the adapter
  scans those bytes directly (matches the existing
  `UploadFinalizeRequest.scanBufferBase64` pattern, useful in
  stub-storage tests + cases where the client still has the buffer
  cached). Omitted: the adapter is expected to fetch the bytes
  from storage by `(bucket, key)` — works in real storage,
  surfaces `skipped` (stub adapter) or `failed` (real adapter
  against stub storage) per the AS pattern.
- Pre-conditions: document belongs to (tenant, claim), upload is
  completed, scan is `clean` or `skipped`. Anything else is a 422 —
  running OCR against a pending / infected upload would either hit
  empty bytes or scan-quarantined bytes.
- Response shape `EobExtractResponse` mirrors `ExtractResult`:
  status (`extracted | low_confidence | skipped | failed`), engine,
  optional fields, optional error.
- Operators trigger the call explicitly rather than auto-running at
  finalize so a heavy real-OCR call doesn't slow the upload-finalize
  path.
- 4 integration tests: short-paid sentinel → extracted with
  deduction line, clean sentinel → no deductions, no buffer + stub
  storage → skipped (forgot-to-attach UX), cross-claim documentId
  → 422.

### AV — EOB OCR adapter skeleton (PR #55)

- New `EobOcrModule` global module with the same shape as
  `VirusScanModule`: a sealed `EobOcrAdapter` interface +
  `EOB_OCR_MODE` env switch (`off` | `stub` | `real`) + a factory
  provider that picks the right implementation. `real` is reserved
  for the OSS pipeline (PaddleOCR / Surya for OCR + Qwen2-VL /
  GOT-OCR2.0 for structured field extraction); the factory falls
  back to disabled with a warning if anyone flips the env early so
  a deploy tier doesn't crash on boot.
- `ExtractedEob` shape lines up with the existing Settlement
  contract: `claimRefNum`, `receivedAmount`, `deductionAmount`,
  `deductions[]`, `shortPaymentReasons[]`, optional `bankTxnId` /
  `receivedAt`. Per-field `confidence` (0–1) accompanies the values
  so the eventual settlement screen can badge auto-extracted fields
  for operator review. Result statuses: `extracted` | `low_confidence`
  | `skipped` | `failed`.
- Stub adapter recognises three sentinel patterns —
  `STUB-EOB-CLEAN-<refnum>-<amount>`, `STUB-EOB-SHORT-<refnum>-
  <received>-<expected>`, `STUB-EOB-FAIL` — so integration tests
  can exercise extracted/failed/low-confidence paths without an
  OCR engine running. `STUB_EOB_SENTINELS` is the public format
  helper for fixture authors.
- 8 unit tests on the adapters cover the sentinel patterns + the
  bucket/key bypass + the noise-tolerance regex anchor + the
  STUB_EOB_SENTINELS round-trip contract.
- No service or controller wiring yet — the next slice will hook the
  adapter into the document scan/finalize pipeline so EOB-typed
  documents get auto-extracted into a draft Settlement form on the
  operator screen.

### AU — Real-clamd integration test (PR #54)

- Closes the validation gap from AQ + AS. The unit suite
  (`clamav-scan.adapter.spec`) proves the adapter speaks INSTREAM
  correctly against a wire-format-faithful `node:net` mock; this
  slice proves the same code talks to a real clamd, picking up any
  drift between our reading of the protocol and clamd's behaviour
  (signature names, edge-case framing, version skew).
- New `apps/api/test/setup/clamav-container.ts` — testcontainers
  helper for `clamav/clamav:1.4` (full image so signatures are
  preloaded and EICAR is detected from the first request).
  Wait-strategy matches any of clamd's "started" / "Listening
  daemon" log lines; 180s startup deadline absorbs cold-cache image
  pulls + signature-DB load on a fresh CI runner.
- New `clamav-real.e2e-spec.ts` runs the `ClamAvScanAdapter`
  directly (no AppModule, no Postgres, no MinIO — only the clamd
  container) against three cases: clean buffer is clean; EICAR
  buffer surfaces `infected` with a non-empty signature (signature
  text varies between `Eicar-Signature` / `Win.Test.EICAR_HDB-1`
  depending on the bundled DB, so we assert non-empty rather than
  exact match); S3-streaming path (Slice AS) routes through a mock
  storage adapter's `getObject` and EICAR is detected on the
  fetched bytes.
- Test timeout is 240s — covers the worst-case cold-runner image
  pull + the three scans inside.

### AT — Inbound rate limit on `/nhcx/inbound` (PR #53)

- Adds `NhcxInboundRateLimitGuard` after the AO signature guard:
  unauthenticated floods are 401'd before they touch the rate counter;
  authenticated floods get throttled to 429.
- Fixed-window counter in-memory, scoped to the controller (the
  whole gateway shows up as a single egress IP from our side, so
  per-IP would have the same shape). Single-replica only — a
  distributed limit needs Redis and lands with the deferred BullMQ
  slice that already touches Redis surface.
- Env: `NHCX_INBOUND_RATE_LIMIT_PER_MINUTE` (default 60 — covers
  expected v1 callback volume by ~10x; misconfigured-gateway floods
  get throttled before they degrade the rest of the API). Set to 0
  to disable; existing integration tests get this for free since
  none of them sets the env explicitly and 60/min comfortably covers
  the per-file callback volume.
- Boundary log fires once per window so ops sees throttle entry
  without pino flooding on every reject.
- 7 unit tests using jest fake timers: limit=0 disables, allows up
  to limit, throws 429 on (limit+1)th, keeps rejecting in same
  window, rolls window after 60s, doesn't roll early at 59s, logs
  exactly once at the boundary.

## Sprint 5 — Real-mode adapters + production-hardening (May 2026)

Ten slices so far (AJ–AS), backfill chore landing alongside. Theme:
every stub adapter the platform stood up over Sprints 2–4 grows a
production sibling, and the security surface gets the missing
authentication, encryption, and signature checks that the Sprint 4
exit doc flagged. End-to-end real-mode upload + virus scan + SMS
notification + JWE-signed inbound now closes the loop.

### AJ — Appeal favourable resolution auto-chains to settlement (PR #41)

- AH/AI deliberately stopped at `APPEAL_RESOLVED` so operators could
  decide what comes next. AJ closes the obvious loop: when the
  resolution kind is `approved` / `partially_approved`,
  `AppealService.resolve` delegates to `SettlementService.expectPayment`
  inside the same flow.
- Service-boundary preservation: AppealService doesn't write payment
  events directly — it calls the existing `expectPayment` so the
  state-machine + settlement-row writes go through one canonical path.
- Rejected resolutions stay manual (operator chooses write-off vs.
  another appeal cycle). Settlement creation is gated on
  `claim.approvedAmount > 0` because the state machine rejects
  `payment.expected` from `APPEAL_RESOLVED` without an approved amount.
- 3 new integration tests: approved auto-chains, partially_approved
  auto-chains, rejected stays at APPEAL_RESOLVED.

### AK — `@ApiTags` on every controller + tag descriptions (PR #42)

- AB shipped Swagger UI with auto-tagged routes (controller class
  names). AK adds explicit `@ApiTags` on all 17 controllers and the
  19 named tag descriptions on the document, so the UI groups by
  domain (`auth`, `cases`, `preauth`, `settlement`, `appeal`, …)
  rather than `AuthController`, `CaseController`, etc.
- Tag-description list lives at the document level in `openapi.ts`;
  order there drives UI presentation order.
- `operationIdFactory` returns `${controllerKey}_${methodKey}` so
  client-codegen tools get readable function names.
- Smoke test (`openapi.spec.ts`) extended to assert that the tag
  descriptions ship on the document and that a representative
  per-controller tag survives the auto-discovery pass.

### AL — Payer remittance batch reconciliation API (PR #43)

- New `POST /settlement/remittance` accepts up to 1000 rows (each:
  `claimRefNum`, `receivedAmount`, optional `receivedAt` / `bankTxnId`
  / `shortPaymentReasons`). Pre-fetches `Claim` rows by
  `claimRefNum` in a single tenant-scoped query, then dispatches each
  row to `SettlementService.recordReceipt` so the existing state-
  machine + ledger semantics stay identical to the per-claim flow.
- Per-row outcome enum: `applied | unmatched_no_claim |
  unmatched_no_settlement | failed`. The endpoint returns the full
  per-row breakdown so the operator UI can show a summary without a
  follow-up request per row.
- Failures don't roll back the batch — applied rows stay applied.
  Strict match on `claimRefNum`; fuzzy / partial matching is a
  hardening item for later if it actually becomes a problem.
- `settlement.upload_eob` permission gate; reader without it → 403.
- 3 integration tests: mixed batch (applied / short-paid / unmatched
  no claim / unmatched no settlement), RBAC, empty batch → 422.

### AM — Remittance batch upload page in the operator UI (PR #44)

- `apps/web/app/(dashboard)/admin/remittance/page.tsx` — paste-CSV →
  preview → apply batch → render results with colour-coded outcome
  badges (`applied`, `unmatched_no_claim`, `unmatched_no_settlement`,
  `failed`).
- Strict CSV parser: split on `\r?\n`, comma-split per row, semicolon-
  split for `shortPaymentReasons`. Required columns: `claimRefNum`,
  `receivedAmount`. Optional: `receivedAt`, `bankTxnId`,
  `shortPaymentReasons`. Operators pre-clean payer exports if their
  format is ugly — a real CSV parser is a Sprint 5+ hardening item if
  it becomes a problem.
- Errors surface through `useErrorModal`; per-row preview lets
  operators sanity-check before applying.
- The UI collects `bankTxnId` per row even though the API drops it
  on the floor at this slice — closed in AN.

### AN — Persist `bankTxnId` on `Settlement` (PR #45)

- Closes the gap from AM. Migration adds nullable `bankTxnId TEXT`
  on the `settlement` table; schema + `SettlementSchema` contract +
  `RecordReceiptRequest` schema all carry the field through.
- `SettlementService.recordReceipt` writes the column when set and
  the `toSettlement` mapper exposes it. Remittance dispatcher
  forwards `row.bankTxnId` instead of the prior log-only behaviour.
- Integration test now reads the raw `Settlement` row through a
  `platform_admin` tx and asserts `bankTxnId === 'BANK-9001'` for a
  row that carried one, and `null` for a row that didn't. Finance
  can now reconcile a settlement back to the originating bank line.

### AO — HCX inbound HTTP signature guard (PR #46)

- The public `/nhcx/inbound` route accepted any TLS-terminated POST
  and relied entirely on JWE for cryptographic proof. AO adds a
  Cavage HTTP-Signature guard at the HTTP edge so unsigned, replayed,
  or impersonated callbacks are rejected with 401 before the body is
  decrypted.
- Pure verifier with explicit support for `rsa-sha256` only, body
  digest binding via the `Digest` header (SHA-256), required-header
  set enforcement (so an attacker can't strip `digest` from the
  signed list), and configurable clock-skew window (default 300s,
  matches the existing JWE TTL).
- `NestExpressApplication` boots with `rawBody: true` so digest
  verification is byte-exact. Boot-time gate: `NODE_ENV=production`
  must set `NHCX_INBOUND_VERIFY_SIGNATURE=true` and
  `NHCX_GATEWAY_PUBLIC_KEY_BASE64`. Dev/test default is permissive
  per the env-gate strictness rule.
- 9 unit tests on the verifier (happy + 7 adversarial mutations) +
  4 integration tests booting the full app with verification
  enabled.
- Bugs caught in CI: supertest sends `Host: 127.0.0.1:<port>`
  regardless of `.set('Host', ...)`, so the signed signing-string
  has to use the actually-bound port (fix: pre-bind + capture the
  AddressInfo). Then `.send(Buffer)` with `Content-Type:
  application/json` makes supertest run the buffer through
  `JSON.stringify`, producing `{"type":"Buffer","data":[...]}` on
  the wire — the digest was on the original buffer, so verification
  failed (fix: send the JS object directly, compute digest on
  canonical `JSON.stringify` bytes).

### AP — KMS-wrap of tenant comms-config secrets at rest (PR #47)

- Closes CLAUDE.md hard-rule #9 for tenant `smtp.password` and
  `sms.apiKey`. Both were going into the `tenant.commsConfig` JSON
  column as plaintext; AP wraps them with AES-256-GCM under a per-
  tenant DEK derived from `PII_KMS_ROOT_KEY_BASE64` via HKDF-SHA256
  (salt `digisparsh-comms-v1`, distinct from the PII path's
  `digisparsh-pii-v1` so a key compromise on one path doesn't bleed
  across).
- On-disk format: `kms:v1:<base64(iv || ct || tag)>`. The prefix
  lets readers distinguish wrapped from legacy plaintext, so
  tenants seeded before AP keep working without a backfill.
- `TenantCommsConfigService.update` wraps before persist;
  `getConfig` unwraps on cache fill so adapters still see plaintext.
- 8 unit tests on the helper (round-trip, IV uniqueness, wrong-
  tenant-key fail-closed, wrong-root fail-closed, salt-namespacing
  isolation, legacy passthrough, key-length validation) + new on-
  disk wrap assertion in `tenant-comms-config.e2e-spec.ts` (reads
  the raw row through a `platform_admin` tx and proves the secrets
  carry the `kms:v1:` prefix and never the input strings).

### AQ — Real ClamAV INSTREAM TCP scan adapter (PR #48)

- Replaces the placeholder fall-through where `VIRUS_SCAN_MODE=real`
  silently routed to the disabled adapter (uploads passed as
  `skipped`). The new adapter speaks clamd's INSTREAM protocol over
  TCP — `zINSTREAM\0` command, 4-byte big-endian length-prefixed
  body chunks (64 KiB), zero-length end-of-stream sentinel — and
  maps clamd's three reply shapes (`stream: OK`,
  `stream: <sig> FOUND`, `... ERROR`) to the existing `ScanResult`
  enum.
- Boot-time gate: `VIRUS_SCAN_MODE=real` requires
  `VIRUS_SCAN_ENDPOINT` (host:port of clamd). Calls without an
  in-memory buffer return `failed` (loud, not silent — S3 streaming
  closed in AS).
- 12 unit tests against a `node:net` mock-clamd server: clean,
  EICAR-shaped infected, hyphenated/dotted signatures, ERROR
  replies, empty replies, multi-chunk payloads (>64 KiB), abrupt
  socket close, missing buffer, missing endpoint, connection refused.

### AR — Real TextGuru SMS provider (PR #49)

- Replaces the log-only stub for tenants whose `commsConfig.sms.provider`
  is `textguru`. POSTs to `<TEXTGURU_BASE_URL>/api/v1/sms/send` with
  bearer auth (the per-tenant `apiKey`, KMS-wrapped at rest since
  AP), JSON body `{ to, message, senderId? }`, 15s default timeout.
  Non-2xx, network errors, and timeouts throw — the upstream
  `notification_outbox` row flips to `failed` and the surrounding
  API request still succeeds (CLAUDE.md: "notification failure must
  not block").
- `SmsAdapter` now delegates to a dedicated `TextGuruSmsProvider`;
  the missing-apiKey case throws (it previously logged a warning
  and silently succeeded, which would silently drop production SMS).
- 9 unit tests against a `node:http` mock server: request shape
  (path, bearer, content-type, body keys), 401/503 throws, timeout,
  missing apiKey, missing base URL, trailing-slash stripping,
  connection refused. Mock uses `closeAllConnections()` so the
  timeout test doesn't leak the worker process between suites.

### AS — ClamAV scans presigned-PUT uploads via S3 streaming (PR #50)

- Closes the production gap from AQ. The ClamAV adapter previously
  returned `failed` for every scan input that lacked an in-memory
  `buffer` — i.e. every upload through the presigned-PUT path
  (which is most of them in `STORAGE_MODE=real`). AS extends
  `StorageAdapter` with `getObject(input) → Promise<Buffer>` and
  threads it through.
- S3 implementation: `GetObjectCommand` + `transformToByteArray`.
  Buffer is bounded by `S3_MAX_UPLOAD_BYTES` (default 50 MiB) so
  it fits in a worker's heap. Stub implementation throws on
  purpose: `VIRUS_SCAN_MODE=real` with `STORAGE_MODE=stub` is a
  misconfig and silent passthroughs are worse than a loud error.
- `ClamAvScanAdapter` now `@Inject`s `STORAGE_ADAPTER` and falls
  through to `getObject` when no buffer is provided. AccessDenied /
  NoSuchKey / etc. surface as `ScanResult { status: 'failed' }` so
  the worker retries and operators see the reason.
- 4 new clamav adapter tests (bucket/key clean, bucket/key EICAR-
  shaped infected, storage throws, neither input present) + 1 stub-
  storage test asserting `getObject` throws with a `STORAGE_MODE=
  real` hint. Buffer-path tests stay; they use a never-call storage
  stub as a regression guard against accidental S3 fetches.

## Sprint 4 — NHCX bidirectional + appeal lifecycle (May 2026)

Ten slices (Z–AI). Theme: close the NHCX integration loop. Sprint 2/3
shipped outbound only; Sprint 4 wires inbound webhooks, threads FHIR
enrichment through every phase, flips all four NHCX outbound flows
to callback-driven in real mode, and adds the appeal lifecycle that
the state machine has been waiting on since Sprint 2.

### Z — NHCX inbound webhook + FHIR response dispatcher (PR #30)

- New public endpoint `POST /nhcx/inbound`. Persists raw payload to
  `integration_message` synchronously, returns 200 within ms, then
  fires async decrypt + dispatch via `.catch`'d fire-and-forget so
  failures land on the row.
- `NhcxInboundService.receive` does idempotency check + outbound
  match + persist (all under `platform_admin` GUC because integration_
  message has FORCE ROW LEVEL SECURITY). `process` decrypts via the
  Slice U key resolver, parses with new FHIR helpers, dispatches to
  existing service `applyDecision` paths.
- Four FHIR response parsers (`CoverageEligibilityResponse`,
  `ClaimResponse` for preauth + final, `Communication`) — pure
  functions, 15 unit tests, tolerant of HCX 0.7.1 shape variations.
- 6 integration tests against an in-process JWE: eligibility +
  preauth dispatch, idempotency, unknown correlationId, missing
  header → 422, malformed JWE → row-failed-crypto.
- Bugs caught in CI: RLS-blocked polling (claims_migrator goes
  through RLS), idempotency collision with Slice K's synthetic
  inbound (differentiated on operation), RLS-blocked service reads
  (wrapped all integration_message reads in platform_admin tx),
  failure classification missing state-machine class
  (`err.constructor.name`, not `err.name`).

### AA — FHIR R4 enrichment for non-eligibility phases (PR #31)

- Slice T wired the FHIR builders into the JWE adapter for eligibility
  only. AA threads `patient + coverage + clinical fields + document
  ids` from preauth / discharge / claim-submit / communication-respond
  orchestrators so all four phases produce real FHIR Bundles.
- New `Claim.payerCode` column + migration. Captured at
  `eligibility.requested`; drives the coverage actor for every
  subsequent phase without re-passing it.
- `FhirContextService.build(tenantId, claimId)` — shared helper that
  walks case → patient → decrypted PII → AdapterPatientFields +
  AdapterCoverageFields. Replaces ad-hoc per-service inlining.
- `NhcxStubAdapter` echoes the full enriched input as `rawRequest`
  on `submitPreauth` + `submitClaim` so integration tests verify
  orchestrator → adapter wiring without a live gateway.
- 6 integration tests: payerCode stamp, preauth/discharge/claim/
  communication enrichment, legacy case (no payer at eligibility)
  keeps coverage undefined → adapter falls back to lightweight
  payload.

### AB — OpenAPI spec + Swagger UI mount (PR #32)

- Originally planned as Slice Y, deferred when Y became the FHIR
  snapshot lock. `@nestjs/swagger@7.4` (Nest-10-compatible major;
  v11+ expects a newer `@nestjs/core` path that doesn't exist in
  pinned 10.3.9 — caught at test time).
- `src/openapi.ts` mounts `/api/docs` (Swagger UI) + `/api/docs-json`
  (raw OpenAPI 3 spec). Cookie-auth security scheme declared globally;
  the UI's "Authorize" button drops the JWT into the right cookie.
- `SWAGGER_ENABLED` env knob (default `true`); production deployments
  flip to `false` for a 404 on both routes.
- 2 unit tests: spec is structurally valid + cookie-auth scheme
  present + routes auto-discovered + disable flag works.
- Auto-tagged from controller class names; per-controller `@ApiTags`
  polish is a follow-up cleanup slice (17 controllers).

### AC — Eligibility callback-driven in real mode (PR #33)

- Removes the duplicate-transition bandaid Slice Z's eligibility test
  had to assert: `expect(['succeeded', 'failed']).toContain(...)`.
  In real mode, the orchestrator now stops at
  `ELIGIBILITY_CHECK_PENDING` and the gateway's webhook callback runs
  the verified/failed transition cleanly.
- `EligibilityService.run` gated on `NHCX_MODE`. Real mode skips the
  synthetic inbound row + the auto-transition. Outbound row stays
  `pending` until the inbound dispatcher pairs the callback.
- New `eligibility-callback-driven.e2e-spec` exercises the real-mode
  path against an in-process mock NHCX gateway (Slice P pattern).

### AD — Preauth callback-driven in real mode (PR #34)

- Same shape as AC but with preauth's two-step state-machine path
  (`DRAFTING → QUEUED → SUBMITTED → APPROVED|REJECTED|...`).
  Orchestrator stops at QUEUED in real mode.
- New `PreauthService.handleInboundResponse` runs the two-step
  transition: ack `QUEUED → SUBMITTED` (with `payerRefNum` stamped
  if available) then delegates to `applyDecision`. Idempotent: ack
  is skipped when claim is already at SUBMITTED (admin escape-hatch
  path).
- `NhcxInboundService.preauth/on_submit` routes through the new
  handler. `applyDecision` stays as the admin escape hatch.
- New `preauth-callback-driven.e2e-spec` against the mock gateway.

### AE — Claim-submit callback-driven in real mode (PR #35)

- Symmetric with AD but with `claim.*` events. Orchestrator stops at
  `CLAIM_QUEUED`; `ClaimSubmitService.handleInboundResponse` runs
  ack + decision.
- `claimRefNum` is stamped synchronously on the claim row at the
  QUEUED step (the JWE adapter's response envelope has it; Sprint 5
  follow-up extends `parseClaimResponse` to extract identifier so
  the stamp moves to the callback).
- New `claim-submit-callback-driven.e2e-spec` walks the full
  pipeline (eligibility + preauth callbacks → discharge synchronous
  → claim submit + callback → CLAIM_APPROVED).

### AF — Discharge callback-driven in real mode (PR #36)

- Last NHCX phase to flip. Discharge has the simplest state-machine
  path (no payer decision — single `DISCHARGE_PENDING →
  DISCHARGE_SUBMITTED` transition) but uses `communication/request`
  for the inbound, so the dispatcher disambiguates three shapes via
  a new `lookupOutboundOperation` helper:
    1. matching outbound = `discharge.submit` → discharge ack (this
       slice)
    2. matching outbound = `preauth.query.respond` → query response
       ack (log-only; the state transition already happened
       synchronously when sent)
    3. no matching outbound → payer-initiated query (Slice Z
       behaviour)
- Sprint 4 milestone: with AF, all four NHCX outbound flows are
  callback-driven in real mode.
- New `discharge-callback-driven.e2e-spec` + cleanup of AE's test
  (which relied on discharge auto-transitioning).

### AG — Sender-code allowlist on /nhcx/inbound (PR #37)

- Defense-in-depth on top of Slice Z's JWE-intrinsic auth. The
  webhook is public; the JWE provides cryptographic guarantees
  *after* decryption succeeds, but doesn't prove the sender claims
  to be a known payer until we open the ciphertext.
- `NhcxSenderAllowlistService` — process-local cache (60s TTL,
  invalidate hook for write-through). Source of truth: `Payer.hcxCode`
  for active rows. Reads under `platform_admin` tx (Payer table has
  FORCE ROW LEVEL SECURITY).
- Default-permit when empty so test rigs without seeded payers keep
  working. Production gets enforcement once the Slice O master-data
  seed loads.
- New `'rejected_sender'` outcome surfaces in logs without writing
  an integration_message row. Controller still returns 200 (NHA
  must not retry on a configuration mismatch).
- 6 unit + 5 integration tests.

### AH — Appeal lifecycle (PR #38)

- The appeal state-machine path has been in `claim.state-machine.ts`
  since Sprint 2 with no service or controller. Operators have been
  doing appeals out-of-band; AH gives them the in-product flow.
- `Appeal` Prisma model + migration `20260521_appeal` with the
  standard tenant-scoped RLS policies. One row per appeal cycle,
  status (`initiated|submitted|resolved`), resolution kind + amount,
  supporting documents.
- `AppealService.start / submit / resolve` driving `appeal.started →
  appeal.submitted → appeal.resolved`. Approved + partially_approved
  stamp `approvedAmount` on the claim row.
- 4 endpoints under `/cases/:c/claims/:cl/appeal/{start,submit,
  resolve}` + `GET` for the open appeal. `settlement.appeal`
  permission gate on writes; `case.view` on the GET.
- Settlement boundary kept clean: AppealService only drives
  `appeal.*` events. Auto-chain to settlement is a Sprint 5 backlog
  item.
- 8 integration tests covering happy + rejection + RBAC + double-
  submit + approved-without-amount validation.

### AI — Appeal panel on case detail (PR #39)

- Wires the AH appeal API to the case detail page. Panel visibility
  gated on three lifecycle bands:
    - **eligible** (PREAUTH_REJECTED / CLAIM_REJECTED / SHORT_PAID)
      → "Ground for appeal" textarea + Start button
    - **live** (APPEAL_INITIATED / APPEAL_SUBMITTED / APPEAL_RESOLVED)
      → action for the current step
    - **historical** (PAYMENT_* / WRITTEN_OFF / CLOSED with an
      existing appeal row) → read-only summary
- `CaseApi` gains `getAppeal / startAppeal / submitAppeal /
  resolveAppeal`.
- Resolve form switches between approved / partially_approved /
  rejected, hides the approvedAmount input on rejected (matches API
  validation).
- Post-resolve hint points operators at the SettlementPanel for the
  next step (write-off / expect payment) — preserves AH's explicit
  no-auto-chain boundary.

## Sprint 3 — Production hardening (May 2026)

Eight slices (R–Y) on top of the Sprint 2 business-domain skeleton.
Theme: every Sprint 2 stub picks up a production sibling, and the
multi-tenant surface gets the encryption / scanning / per-tenant
config that compliance asks for. CI gate now also runs MinIO + the
FHIR snapshot tests.

### R — Encrypted patient PII (PR #21)

- `Patient` model with envelope-encrypted Aadhaar / ABHA / policy /
  mobile / email — AES-256-GCM with per-tenant DEK derived via
  HKDF-SHA256 from `PII_KMS_ROOT_KEY_BASE64`. Ciphertext blob is
  `base64(iv || ct || tag)` with `keyVersion` stored alongside so
  rotation doesn't require atomic re-encrypt.
- Exact-match lookup hashes (`aadhaarHash`, `mobileHash`) co-located
  with the ciphertext so we find a patient without a full-table
  decrypt scan.
- `CaseService.create` atomically creates the `Patient` row inside the
  same tenant tx when `CreateCaseRequest.patient` is supplied. Legacy
  cases (no PII) keep `patientId = null`.
- Real OVH KMS deferred to Sprint 5; config loader rejects
  `PII_KMS_MODE=real`. Production-only enforcement of
  `PII_KMS_ROOT_KEY_BASE64` so non-prod test harnesses don't have to
  mint a 32-byte key.
- 12 unit + 4 integration tests.

### S — Document virus-scan + lifecycle sweep (PR #22)

- `VirusScanAdapter` interface + three impls gated by
  `VIRUS_SCAN_MODE` — `off` / `stub` (EICAR detect) / `real`
  (ClamAV INSTREAM, deferred to Sprint 5).
- `finalizeUpload` runs the scanner; infected rows flip
  `scanStatus='infected'` + return 422. `hasDocumentType()` now
  requires `scanStatus IN ('clean','skipped')` so infected uploads
  never satisfy the discharge / claim-submit checklist.
- `DocumentLifecycleWorker` sweeps `pending` rows older than
  `DOC_PENDING_TTL_MINUTES` (default 60) to `failed`, so stale uploads
  stop showing up as "still uploading".
- 5 unit + 3 integration tests.

### T — Real FHIR R4 bundle builders (PR #23)

- Four pure-function builders for the HCX 0.7.1 profile:
  `CoverageEligibilityRequest` (eligibility), `Claim use=preauthorization`
  (preauth submit), `Claim use=claim` (final submit with `Binary` refs),
  `Communication` (query response + discharge submit).
- `NhcxJweAdapter` materialises bundles when patient/coverage/clinical
  fields are supplied; falls back to the legacy lightweight payload
  otherwise so the stub and existing call sites keep working.
- Eligibility service forwards plaintext patient fields + decrypts the
  linked `Patient` row to populate `dateOfBirth` / `gender` / `abhaId`.
  Aadhaar / mobile / email never leave the database.
- Sprint 5 follow-up: forward enriched fields from preauth /
  discharge / claim-submit too. Eligibility was wired first as the
  highest-traffic NHCX call.
- 11 unit + 1 integration test.

### U — ABDM token cache + NHCX key rotation (PR #24)

- `TokenCache` — process-local TTL cache for ABDM OAuth2 tokens with
  concurrent-miss collapse (no thundering herd at expiry).
  `HprRealAdapter` reads via the cache + `httpJsonWith401Retry`
  invalidates and remints on a 401 then retries the original call once.
- `EnvKeyResolver` (NHCX) maps version strings to PEM blobs. Active
  version (`NHCX_PRIVATE_KEY_VERSION`, default `v1`) drives outbound
  encryption (`kid` stamped on the JWE header). Inbound JWEs decrypt
  using the version named in their `kid`, so v1 ciphertext from NHCX
  still opens after we cut over to v2 outbound. Adding v3 = a new env
  slot + a one-line resolver entry.
- `nhcx.crypto.readJweKid` exposes `decodeProtectedHeader` so the
  adapter reads `kid` without partial-decrypting the payload.
- 12 unit + 2 integration tests.

### V — Audit viewer + streaming CSV export (PR #25)

- `GET /audit` — paginated list with filters (from / to, action,
  resourceType, resourceId, actorUserId, correlationId), gated by
  `audit.view`.
- `GET /audit/export.csv` — same filters, streamed via the underlying
  Express response. `AuditService.streamForExport` is an async
  generator yielding 500-row batches; controller pipes straight to
  `res.write`. 100k-row hard cap so memory stays bounded.
- `apps/web/.../admin/audit/page.tsx` — filter inputs, paginated
  table, "Download CSV" anchor that opens the export URL with cookies
  attached so the browser handles streaming + the download flow.
- 6 integration tests including a cross-tenant isolation canary.

### W — Real-MinIO S3 round-trip + finalize-failure tests (PR #26)

- `test/setup/minio-container.ts` spins up MinIO via testcontainers
  and creates the test bucket. Drop-in S3 API surface so SigV4
  presigned PUT + HEAD work unchanged against it.
- `document-real-s3.e2e-spec.ts` — happy path (upload-init → PUT
  bytes via the presigned URL with `fetch` mirroring the browser →
  finalize captures the real etag and observed content-length) and
  failure path (skip the PUT → finalize HEAD returns 404 → row flips
  to `failed` with `uploadError`, surface 422).
- Closes the two gaps called out in the Slice P2 PR.
- `cross-env NODE_OPTIONS=--experimental-vm-modules` on the
  integration runner so the AWS SDK v3's dynamic imports
  (middleware-retry) resolve under Jest. `cross-env` added as a devDep
  for portable shell behaviour.
- Post-CreateBucket `HeadBucket` poll (5x / 200ms) handles MinIO's
  occasional bucket-visibility lag after create.

### X — Per-tenant SMTP + SMS config (PR #27)

- `Tenant.commsConfig` JSONB stores per-tenant overrides for the
  SMTP relay and SMS provider; falls back to platform env defaults
  when unset.
- `TenantCommsConfigService` resolves + caches per-tenant config (60s
  TTL, invalidate on write). `EmailAdapter` and `SmsAdapter` thread
  `tenantId` through every send so per-tenant Transporters and SMS
  providers select cleanly. `TextGuru` provider is a logging stub
  today; real HTTP integration in Sprint 5.
- `PATCH /tenant/comms-config` edits, `GET` returns a redacted summary
  (`passwordSet` / `apiKeySet` flags — never raw secrets). New
  permission `tenant.comms_config.update` gates both verbs; seeded
  into `tenant_admin` and `platform_admin`.
- `apps/web/.../admin/comms-config/page.tsx` — operator form that
  preserves existing secrets when the password / api-key fields are
  left blank.
- Bug fix: `SMTP_PORT` coerced to number at the resolver boundary
  because `ConfigService` can surface raw env strings.
- 6 unit + 5 integration tests.

### Y — FHIR builder snapshot lock (PR #28)

- Optional `uuid` + `now` factory injection on the four NHCX FHIR R4
  builder inputs (`FhirDeterminismDeps`). Production callers omit
  them; defaults remain `crypto.randomUUID` and the system clock.
- `apps/api/src/modules/nhcx/fhir-builders.snapshot.spec.ts` — 4 tests
  building each bundle with deterministic factories and asserting
  deep equality against pretty-printed reference fixtures in
  `reference/fhir-bundles/`. Set `UPDATE_FIXTURES=1` to regenerate
  intentionally; the diff lands in the PR for review.
- `reference/fhir-bundles/{eligibility-request,preauth-submit,claim-submit,communication}.json`
  — committed canonical bundles (the directory CLAUDE.md already
  pointed at for contract tests).

## Sprint 2 — Business domain + real adapters (May 2026)

Nine slices (I–Q) building the case → preauth → discharge → claim →
settlement pipeline on top of the Sprint 1 auth surface, plus the
first real-network NHCX / ABDM / S3 adapters and the production-deploy
hardening. CI gate adds the integration_message ledger canaries.

### I — Event-sourced claim aggregate engine (PR #10)

- Three new tables: `case` (minimal — patient details are placeholder
  strings until the encrypted Patient model lands in Slice R),
  `claim` (materialised state), `claim_event` (append-only via RLS).
- Full 35-status `ClaimStatus` enum + 38 `ClaimEventType` verbs lifted
  verbatim from `docs/04-state-machines.md`. Explicit transition table
  (~55 rows) with O(1) lookups; module-load asserts uniqueness so a
  duplicate transition fails fast.
- `ClaimService.create` / `transition` / `findById` / `listEvents`.
  Every transition opens a tenant-context tx, validates `(from, event)`,
  writes a `ClaimEvent`, updates the materialised `claim.status`
  atomically, and auto-stamps `submittedAt` / `approvedAt` / `paidAt`
  / `closedAt` based on the resulting status.
- `ClaimReconstructionService.replay` — pure function over the event
  log. Reports `{status, eventCount, history, consistent}`.
- `claim_event` has `USING(false)` on UPDATE/DELETE so application
  code that tries to mutate a recorded event is silently rejected.
- 11 unit + 6 integration tests.

### J — Case + claim CRUD over HTTP (PR #11)

- `POST /cases` creates the `Case` row AND mints the first `Claim`
  via `ClaimService.create` (two writes, separate txs) so callers
  get a fully-shaped aggregate from one round-trip. Atomic wrapping
  deferred until the encrypted Patient model lands.
- `CaseController` — `POST` / `GET` / `GET /:id` / `PATCH`, gated by
  `case.create` / `case.view` / `case.assign`.
- `ClaimController` — `GET /cases/:cid/claims/:clid/events` (timeline)
  + `POST .../transitions` (admin manual transition gated by
  `case.assign` — production transitions come from rail adapters).
- Wire shapes: `CaseSummary` (list page) + `CaseDetail` (detail page,
  embeds claims) + `ClaimEventListItem` (timeline). Server-side
  pagination clamped to `[1, 200]`.
- Web: `/cases` list with status filter, `/cases/new` create form,
  `/cases/[id]` detail panel with claims + timeline.
- 8 integration tests including cross-tenant invisibility canary.

### K — NHCX-stub eligibility cycle + integration_message ledger (PR #12)

- `IntegrationMessage` model — every external call (NHCX, PMJAY,
  ABDM, OpenAI, SMTP, TextGuru) writes a paired outbound + inbound
  row sharing one `correlationId`. `status` flips
  `pending → succeeded | failed`; `failureClass` classifies
  network / auth / validation / 5xx.
- `IntegrationMessageService.recordOutboundWithTx` (atomic with the
  surrounding state change), `markSucceeded` (updates outbound +
  writes inbound), `markFailed`, `listForClaim`.
- `NhcxStubAdapter` — env-driven verify result with per-MRN fail-list
  override. Mirrors the eventual real-adapter shape so swap is
  contained to one file in Slice P. 5ms mock latency.
- `EligibilityService` orchestrator — opens a tenant tx, transitions
  `eligibility.requested`, calls the adapter outside the tx (no
  network round-trip while holding locks), writes paired ledger rows
  under one correlationId, transitions to `ELIGIBILITY_VERIFIED` or
  `ELIGIBILITY_FAILED`.
- `POST /cases/:c/claims/:cl/eligibility` (`case.create`) +
  `GET .../integration-messages` (`case.view`).
- Web: case detail gains an Eligibility action panel + ledger view.
- 6 integration tests.

### L — Pre-auth phase end to end (PR #13)

- `preauth_draft` (one row per claim, unique on `claimId`, upsert);
  per-field state captured in `submittedSnapshot` at submit so a
  later edit can't silently change what we believe we sent.
- `preauth_query` — payer-raised queries; `respondedAt` /
  `responseText` flip on response.
- `NhcxStubAdapter` gains `submitPreauth` / `respondPreauthQuery`.
  `EligibilityModule` now exports the adapter so `PreauthModule`
  shares it (one fewer instance).
- `PreauthService` — `saveDraft` (upsert), `submit` (required-field
  check, `DRAFTING → QUEUED`, adapter call, paired ledger rows,
  `QUEUED → SUBMITTED` with `payerRefNum` stamped on the claim),
  `applyDecision` (admin escape hatch + path Slice P's adapter
  callback wires through), `respondToQuery`.
- Endpoints under `/cases/:c/claims/:cl/preauth` gated separately by
  `preauth.draft` / `preauth.submit` / `preauth.respond_query` /
  `case.assign`.
- Web: `PreauthPanel` on case detail. Form binds to the draft;
  Save / Submit are split. Form goes read-only once the claim leaves
  `DRAFTING` / `QUEUED`.
- 7 integration tests.

### M — Discharge + claim submit phase end to end (PR #14)

- `Document` model — file metadata only; binaries land in S3 in
  Slice P2. Tenant-scoped, indexed on `(claimId, documentType)` so
  the required-doc check is a cheap count.
- `DocumentService.uploadStub` creates a synthetic
  `storageBucket` / `storageKey` so downstream flows have a row to
  link.
- `NhcxStubAdapter` gains `submitDischarge` / `submitClaim` —
  acknowledged-only, decisions still arrive via the admin endpoint.
- `DischargeService.initiate` / `submit` — submit guards on at-least-
  one document of type `discharge_summary`; missing → 422.
- `ClaimSubmitService.start` / `submit` / `applyDecision`. `submit`
  takes `finalAmount` on the wire (the requested pre-auth amount
  was an estimate; `finalAmount` is what we're actually billing).
- Endpoints under `/cases/:c/claims/:cl/{documents, discharge,
  claim-submission}` with permission gates per verb.
- Web: `ClaimPhasePanel` on case detail with inline document upload
  stub + discharge / claim submit buttons gated on status.
- 7 integration tests.

### N — Settlement: payment, EOB, reconciliation, write-off (PR #15)

- `Settlement` model — one row per claim, unique on `claimId`. Tracks
  `expectedAmount`, `receivedAmount`, `deductionAmount`, structured
  `deductions` JSONB, `shortPaymentReasons`, `eobDocumentId` (FK-by-id
  to `Document`), `reconciliationStatus`
  (`manual_match_pending → auto_matched | short_paid | discrepancy`),
  `closedAt`.
- `SettlementService` — `expectPayment` (idempotent upsert + drives
  `payment.expected`), `recordReceipt` (auto-classifies `short_paid`
  when `received < expected`, drives `payment.received` →
  `payment.short_paid`, stamps `paidAmount` on the claim),
  `reconcile`, `writeOff` (drives `claim.written_off` — terminal-
  bound), `close` (drives `claim.closed` + stamps `closedAt`).
- Endpoints under `/cases/:c/claims/:cl/settlement` gated by
  `case.assign` / `settlement.upload_eob` /
  `settlement.categorize_deduct` / `settlement.write_off`.
- Web: `SettlementPanel` on the case detail page, status-conditional
  CTAs (receipt, reconcile, write-off, close) from `CLAIM_APPROVED`
  through `CLOSED`.
- State-machine fix mid-slice: `payment.short_paid` only follows
  `payment.received`, never directly from `PAYMENT_PENDING`. Same
  materialised state, valid event sequence.
- 7 integration tests.

### O — Master data: payer, package, ICD, billing, checklist (PR #16)

- Platform-level catalogues (no `tenantId`) — `Payer` (TPA / insurer /
  SHA / CGHS / self with NHCX participant code), `Package` (PMJAY HBP
  + private-rail tariff), `IcdCode` (ICD-10-CM with description
  search), `BillingCode`, `DocumentChecklistRule`.
- `resolveChecklist` picks the most-specific rule per `documentType`
  with a (phase, rail) → optional payer / package / admissionType
  precedence.
- RLS — SELECT open to any authenticated context, INSERT/UPDATE/DELETE
  `platform_admin` only. Endpoints under `/payers`, `/packages`,
  `/icd-codes`, `/billing-codes`, `/document-checklist-rules` gated by
  `payer.master.{view,edit}` / `package.master.sync` /
  `document_checklist.edit`.
- Seed: `pnpm db:seed:master` loads 10 payers, 14 packages, 21 ICD
  codes, 15 billing codes, 13 checklist rules — idempotent.
- Side change: `ZodValidationPipe` now uses
  `ZodType<T, ZodTypeDef, unknown>` so schemas with `.transform()`
  pass the constraint.
- 7 integration tests.

### P — Real NHCX JWE adapter + mode switch (PR #17)

- `NhcxAdapter` interface lifted into its own `@Global` module with
  two impls: `NhcxStubAdapter` (existing behaviour) and
  `NhcxJweAdapter` (RSA-OAEP-256 + A256GCM JWE wrapping over native
  `fetch`, configurable gateway URL).
- `NHCX_MODE=stub|real` (default `stub`). Real mode requires
  `NHCX_GATEWAY_URL`, `NHCX_PARTICIPANT_CODE`,
  `NHCX_PRIVATE_KEY_BASE64`, `NHCX_GATEWAY_PUBLIC_KEY_BASE64` —
  config loader rejects boot when missing.
- Consumers (eligibility, preauth, discharge, claim-submit) now
  inject the `NHCX_ADAPTER` token instead of the concrete class so
  swap is transparent.
- `nhcx.crypto` — `jose` v5 (pinned for CJS interop). Imported keys
  are cached keyed on PEM string so per-request encryption isn't
  paying the SPKI parse cost.
- 3 unit + 4 integration tests against an in-process mock gateway:
  encrypt/decrypt round-trip, opaque-on-the-wire (PHI never appears
  plaintext), HTTP 503 surfaces as a thrown error, payload propagation.

### P2 — S3 presigned upload pipeline (PR #18)

- `StorageAdapter` interface + two impls: `StubStorageAdapter`
  (synthetic refs, dev + tests) and `S3StorageAdapter` (presigned
  PUTs against an S3-compatible service via AWS SDK v3 — OVH default,
  works against MinIO / AWS S3 too).
- `STORAGE_MODE=stub|real`; real mode requires
  `OVH_S3_{ENDPOINT,REGION,BUCKET,ACCESS_KEY,SECRET_KEY}`.
- `Document` table extended: `uploadStatus`
  (`pending|completed|failed`), `contentSha256`, `uploadError`,
  `finalizedAt`. Existing rows backfill to `completed`.
- Two new endpoints — `POST .../documents/upload-init` allocates a key,
  signs a PUT URL, creates the `pending` row; `POST .../finalize` HEADs
  the object, captures `etag` + size, flips the row to `completed`.
  Legacy `/upload-stub` retained for backward compat + dev.
- `hasDocumentType()` now requires `uploadStatus='completed'` so
  pending uploads don't satisfy the discharge / claim checklist.
- 2 unit + 4 integration tests.

### P3 — Real ABDM HPR adapter + two-step OTP flow (PR #19)

- `HprAdapter` interface + `HPR_ADAPTER` token. Two impls:
    - `HprStubAdapter` — moved from `doctor/hpr.service.ts`. Allowlist
      + fixed-OTP gating. Now exposes `requestOtp()` returning a
      synthetic `transactionId` so the two-step flow works in stub
      mode.
    - `HprRealAdapter` — talks to ABDM Sandbox over `fetch`:
      `/gateway/v0.5/sessions` (access token), `/api/v1/auth/init`
      (txnId), `/api/v1/auth/confirmWithMobileOTP` (x-token),
      `/api/v2/hpr/healthcareprofessional/{hprId}` (profile).
      Failures bucket up into `HprVerificationFailedError` so callers
      can't distinguish "wrong OTP" from "wrong HPR" (D-014).
- `HPR_MODE=stub|real` (default `stub`). Real mode requires
  `ABDM_BASE_URL` / `ABDM_CLIENT_ID` / `ABDM_CLIENT_SECRET`;
  `ABDM_HTTP_TIMEOUT_MS` bounds each leg.
- `DoctorTokenService` injects `HPR_ADAPTER` and exposes
  `requestHprOtp()`. `SignWithDoctorTokenInput` grows an optional
  `hprTransactionId` — required by the real adapter (links the OTP
  back to init), ignored by the stub.
- New endpoint `POST /preauth/doctor-tokens/:rawToken/hpr-init` (step
  1 of the two-step real-ABDM flow).
- 5 unit + 5 integration tests against a mock ABDM sandbox.

### Q — Security headers + retry worker + readiness probe (PR #20)

- Security-headers middleware, hand-rolled rather than helmet so the
  policy is auditable. CSP (`default-src 'none'`,
  `connect-src CORS_ORIGIN`), `X-Content-Type-Options`,
  `X-Frame-Options DENY`, `Referrer-Policy no-referrer`,
  `Permissions-Policy` denying camera/mic/etc, COOP `same-origin`,
  CORP `same-site`. HSTS gated on `COOKIE_SECURE` — production
  preload-grade, non-prod `max-age=300` to avoid locking dev. Express
  `X-Powered-By` stripped.
- `NotificationRetryWorker` — in-process timer that drains
  `notification_outbox` rows in `queued|failed` state with
  `attempts < cap`. Exponential back-off (0s / 60s / 5m / 30m / 2h).
  Permanent failures (unknown template, channel mismatch) burn all
  attempts atomically. Disable in tests via
  `NOTIFICATION_RETRY_DISABLED=true`.
- `/health/ready` reports database connectivity,
  `_prisma_migrations` freshness (every applied migration finished +
  not rolled back), bound adapter modes (nhcx / hpr / storage), and
  build provenance — load balancers can pull instances out of
  rotation when migrations are mid-flight or rolled back.
- 4 unit (security headers) + 6 unit (retry back-off schedule) +
  4 integration tests.

## Sprint 1 — Auth + onboarding (May 2026)

Authentication, RBAC, MFA, sessions, doctor signature, tenant onboarding
and lifecycle. 65 integration tests; CI gate is the RLS canary +
end-to-end auth flows.

### A — RBAC + audit pipeline (PR #2)

- `RolesGuard` + `@RequirePermission` decorator backed by the
  JWT-embedded permission set (no per-request DB hit).
- `AuditService.record` / `recordWithTx` + Slice-A audit events
  (`USER_LOGGED_IN/OUT/FAILED_LOGIN/LOCKED`).
- 3-phase login split fixes a pre-existing lockout bug — failed-attempt
  counters now persist across `throw` in the failure path.

### B — Invitation flow + notifications (PR #3)

- `POST /tenant/users` admin invite + `POST /tenant/users/:id/resend-invite`.
- `POST /auth/accept-invite` + `GET /auth/invite/:token` preview.
- `NotificationService` with persistent outbox pattern; post-commit
  dispatch so notification failure never rolls back state changes.
- Invite resend rate-limited (3/24h per user).

### C — Password policy + reset + history (PR #4)

- `PasswordPolicyService` — length, composition, contextual (no email /
  name), bundled offline breach list (sha1 hex set), reuse-of-last-5.
- `POST /auth/password-reset/{initiate,verify,complete}` + opaque
  30-min tokens, 5/day rate limit, silent on unknown email.
- `POST /auth/me/password` self-change with current-password proof.
- `password_history` (append-only via RLS).

### D — MFA — TOTP + backup codes (PR #5)

- `TotpService` (otplib) + `BackupCodeService` (10 single-use
  Crockford-base32 codes per batch).
- `POST /auth/me/mfa/{setup,confirm,disable}` +
  `POST /auth/me/mfa/backup-codes/regenerate`.
- 5-minute MFA challenges replace the access token issue when MFA is
  enabled. `POST /auth/mfa/verify` finishes login.
- Same-step TOTP replay blocked via `lastUsedStep` on the enrolment row.

### E — Sessions, IP allowlist, trusted devices, concurrent cap (PR #6)

- IP allowlist as tenant-level CIDR list (jsonb). IPv4 + IPv6.
  Hand-rolled matcher (deprecated `ip` package avoided). platform_admin
  bypasses; IPv4-mapped IPv6 (`::ffff:1.2.3.4`) normalised before match.
- `claims_trust` cookie + `TrustedDevice` model — opting into "trust
  this device for 30 days" on the MFA challenge skips MFA on follow-up
  logins from the same UA.
- Concurrent-session cap (default 5) — FIFO eviction at the cap+1th
  login with `SESSION_REVOKED` audit + history-row to keep the
  refresh-reuse detector intact.
- `GET /auth/me/sessions`, `DELETE /auth/me/sessions/:id`,
  `GET /auth/me/trusted-devices`, `DELETE /auth/me/trusted-devices/:id`,
  `GET/PUT /tenant/security/ip-allowlist`.

### F — Doctor short-token + HPR stub (PR #7)

- `DoctorTokenService` + `HprService` (env-allowlist stub mirroring the
  shape of the eventual ABDM HPR API).
- `POST /preauth/doctor-tokens` (auth, perm `preauth.sign_clinical`),
  `GET /preauth/doctor-tokens/:rawToken/preview` (public),
  `POST /preauth/doctor-tokens/:rawToken/sign` (public).
- 10-minute token TTL; single-use; `DOCTOR_SIGNED` audit captures HPR
  id + verified full name + clinical note.

### G — Onboarding + readiness + lifecycle FSM (PR #8)

- 8 canonical onboarding step keys + idempotent upsert at
  `POST /tenant/onboarding/steps/:key/complete`.
- `ReadinessService` — pure check over steps + tenant_admin presence +
  non-terminal lifecycle.
- `TenantLifecycleService` — explicit FSM
  (`CONTRACTED → PROVISIONING → IN_SETUP → PILOT → LIVE`,
  `LIVE ↔ SUSPENDED`, `PILOT/LIVE → CHURNED`). FSM check runs before
  readiness so the more actionable `LIFECYCLE_TRANSITION_INVALID`
  surfaces over `READINESS_CHECK_FAILED`.

### H — Cleanup + sprint exit

- 4 runbooks (locked-account, lost-MFA, IP-allowlist self-lockout,
  refresh-reuse detected) under `docs/runbooks/`.
- `docs/sprint-1-exit.md` summarises what shipped + Sprint 2 backlog.
- This changelog file.

## Sprint 0 — Walking skeleton (May 2026, PR #1)

- pnpm monorepo (`apps/api` NestJS 10, `apps/web` Next.js 14,
  `packages/{contracts,error-codes,ui-tokens}`).
- Postgres 16 with `claims_migrator` (owner) + `claims_app` (runtime,
  no BYPASSRLS) roles.
- Tenant-scoped RLS via `set_config('app.tenant_id', ..., true)` GUC;
  8-assertion canary integration test as the gate.
- RS256 JWT cookies + refresh-token rotation + reuse-detection.
- CI: lint + type-check, unit tests, integration tests on testcontainers
  Postgres.
