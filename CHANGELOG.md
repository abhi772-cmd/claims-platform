# Changelog

Notable changes to the DigiSparsh Claims Platform. The format is loosely
[Keep a Changelog](https://keepachangelog.com/) but oriented around
sprint slices rather than calendar releases.

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
