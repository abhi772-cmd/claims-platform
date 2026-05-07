# Changelog

Notable changes to the DigiSparsh Claims Platform. The format is loosely
[Keep a Changelog](https://keepachangelog.com/) but oriented around
sprint slices rather than calendar releases.

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

### BE — `/health/ready/deep` deep-readiness probe

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
