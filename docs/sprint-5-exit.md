# Sprint 5 — Exit document

Sprint window: started after PR #40 (Sprint 4 paperwork pause) merged
on 2026-05-07; this doc is written at the Sprint 5 paperwork pause on
2026-05-07 with PR #50 (Slice AS) on `main` and the per-slice
CHANGELOG backfill landed via PR #51.

## What shipped

Ten slices on top of the Sprint 4 NHCX-bidirectional surface. Theme:
production-hardening — every stub adapter the platform stood up over
Sprints 2–4 grows a production sibling, the security surface picks up
the missing authentication/encryption checks the Sprint 4 exit doc
flagged, and the settlement workflow gains the remittance
reconciliation operators have been asking for. End-to-end real-mode
upload + virus scan + SMS notification + JWE-signed inbound now closes
the loop.

| Slice | Theme                                                          | PR  |
| ----- | -------------------------------------------------------------- | --- |
| AJ    | Appeal favourable resolution auto-chains to settlement         | #41 |
| AK    | `@ApiTags` on every controller + tag descriptions              | #42 |
| AL    | Payer remittance batch reconciliation API                      | #43 |
| AM    | Remittance batch upload page in the operator UI                | #44 |
| AN    | Persist `bankTxnId` on `Settlement`                            | #45 |
| AO    | HCX inbound HTTP signature guard                               | #46 |
| AP    | KMS-wrap of tenant comms-config secrets at rest                | #47 |
| AQ    | Real ClamAV INSTREAM TCP scan adapter (buffer path)            | #48 |
| AR    | Real TextGuru SMS provider                                     | #49 |
| AS    | ClamAV scans presigned-PUT uploads via S3 streaming            | #50 |

Plus PR #51 — paperwork chore that backfilled the CHANGELOG entries
the per-PR discipline missed across AJ–AS.

See `CHANGELOG.md` for per-slice detail.

## Test coverage at exit

| Suite (representative)                            | Cases | Notes                                                    |
| ------------------------------------------------- | ----- | -------------------------------------------------------- |
| `remittance-batch.e2e`                            |   3   | Slice AL — mixed batch + RBAC + empty-batch validation   |
| `http-signature.spec`                             |   9   | Slice AO — verifier round-trip + 7 adversarial mutations |
| `nhcx-inbound-signature.e2e`                      |   4   | Slice AO — full app boot with verification enabled       |
| `comms-secret.crypto.spec`                        |   8   | Slice AP — wrap/unwrap + salt-namespacing isolation      |
| `clamav-scan.adapter.spec`                        |  16   | Slices AQ + AS — INSTREAM protocol + S3-streaming paths  |
| `textguru-sms.provider.spec`                      |   9   | Slice AR — request shape + failure modes                 |
| **Sprint 5 additions**                            | **~60** | On top of the existing ~277 cases from Sprint 1–4      |

The CI gate now also exercises real-protocol clamd over a `node:net`
mock + real-protocol TextGuru over a `node:http` mock, so the
production paths are wire-format-correct without testcontainers
overhead. Total integration suite at exit: **~37 spec files,
~210 cases**; total unit suite **~250 cases**.

## Decisions worth remembering

- **`kms:v1:` prefix as the wrap-detection sentinel (Slice AP)** —
  KMS-wrapped values land on disk as `kms:v1:<base64(iv || ct ||
  tag)>`. The prefix lets the unwrap path detect wrapped vs. legacy-
  plaintext rows by inspection, so tenants seeded before AP keep
  working without a backfill migration. Generalises to any future
  envelope-encrypted column where pre-existing rows might be present.
- **HKDF salt namespacing for cross-domain DEKs (Slice AP)** — same
  root key, same tenant id, but the comms-config DEK and the PII
  DEK derive different bytes because their HKDF salts differ
  (`digisparsh-comms-v1` vs `digisparsh-pii-v1`). Keeps the blast
  radius of either domain's plaintext exposure bounded to that
  domain. Watchword for future "share root key, isolate sub-keys"
  designs.
- **Body-digest-must-be-signed in HTTP-Signature (Slice AO)** — our
  verifier rejects a signature whose `headers` parameter omits any
  of `(request-target) host date digest x-hcx-correlation-id
  x-hcx-operation`. Without that requirement an attacker could
  strip `digest` from the signed list and the signature still
  verifies — the body integrity binding only holds if the digest
  header is bound to the signature. Pattern is general to any
  Cavage-style verifier we add later.
- **Loud failure beats silent passthrough on scan path (Slices AQ +
  AS)** — both adapters return `ScanResult { status: 'failed' }`
  when they can't actually scan (no buffer + no bucket/key, S3
  fetch error, missing endpoint, stub storage adapter in real
  scan mode). The scan worker treats `failed` as transient and
  retries; ops sees the reason in the row. The alternative (return
  `clean` when we can't scan) would silently let unscanned uploads
  through in production, which is the worst possible outcome.
- **Service-boundary preservation on auto-chain (Slice AJ)** —
  AppealService.resolve doesn't write payment events directly; it
  delegates to SettlementService.expectPayment so the state-machine
  + ledger writes go through one canonical path. Watchword: when
  closing a workflow loop across two services, route through the
  destination service's existing entry point rather than duplicating
  its writes.
- **Strict CSV beats lenient parsing in operator paste-paths (Slice
  AM)** — the remittance UI's CSV parser splits on commas and
  semicolons with no quoting / escaping support. Operators pre-clean
  payer exports if they're ugly. A tolerant parser would silently
  drop rows the operator didn't realise had embedded commas — worse
  than a noisy parse error that surfaces the issue.
- **Per-PR CHANGELOG discipline (lapsed; backfilled in PR #51)** —
  the project convention is per-PR CHANGELOG entries (PR #29 and
  #40 are existence proofs that backfill is painful). Sprint 5
  shipped ten consecutive PRs without entries; PR #51 had to
  reconstruct what shipped from commit messages and code. Every
  future slice PR's `git diff --stat` should include CHANGELOG.md
  alongside the code changes.

## Bugs caught during the sprint

- **Slice AO host-mismatch chain** — the HTTP-Signature happy-path
  test failed twice in CI before the actual root cause surfaced.
  First red herring: supertest sets `Host: 127.0.0.1:<port>`
  regardless of `.set('Host', ...)`, so the signed signing-string
  needs to use the actually-bound port. After fixing the host, the
  digest still didn't match — root cause was that `.send(Buffer)`
  with `Content-Type: application/json` makes supertest run the
  buffer through `JSON.stringify`, producing `{"type":"Buffer",
  "data":[...]}` on the wire. The signed digest was on the original
  buffer; verification failed by one byte. Fix: send the JS object
  directly and compute the digest on `Buffer.from(JSON.stringify
  (obj))`. Saved as feedback memory `feedback_supertest_buffer_send`
  so future signature-style slices don't relive the chain.
- **Slice AR worker-process leak** — the timeout test in
  `textguru-sms.provider.spec.ts` left in-flight sockets pinned
  because `server.close()` waits for connections to drain at the OS
  level. Fix: call `server.closeAllConnections()` before
  `server.close()` in the mock-server teardown. Pattern is reusable
  for any future "test against a hanging server" suite.

## Deferred to Sprint 6

| Item                                                                | Why deferred                                                                                                |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Real OVH KMS for the PII + comms root key                           | Stub-mode env-supplied root key is acceptable until OVH KMS credentials are provisioned; AP wrap-format works either way. |
| Real job queue (BullMQ on existing Redis)                           | The current notification-retry worker uses in-process polling; correctness is fine, scale is the concern.    |
| PMJAY rail adapter                                                  | Net-new integration; needs SHA + state-by-state mode routing design. Multi-slice undertaking.               |
| EOB OCR (Textract / Document AI)                                    | Net-new feature; depends on external service credentials.                                                   |
| Inbound rate limiting on `/nhcx/inbound`                            | Defense-in-depth — gateway is upstream-rate-limited, not currently a real risk vector.                       |
| Document scan worker integration test against real clamd container | Unit tests exercise the protocol against a wire-format-faithful mock; testcontainers clamd would add ~1 min CI time for low marginal confidence. |
| `parseClaimResponse` extracts identifier (Slice AE follow-up)        | Synchronous claimRefNum stamping at QUEUED works in production. Cosmetic refactor.                          |
| Real-clamd e2e test combining MinIO + clamd containers              | Validation of AS in a fully real environment. Heavy CI + likely flaky.                                      |
| Inbound message types not yet wired (`insuranceplan/on_request`, `paymentnotice/request`, `task/on_submit`) | Pattern is clear from Slices Z + AF; no operational pressure yet. |

## Operational artefacts

- **End-to-end real-mode loop is closed** — a presigned-PUT upload
  from the web client now reaches S3, the scan worker pulls the
  bytes back via `StorageAdapter.getObject`, streams them to clamd
  over INSTREAM, and surfaces the verdict on the `Document` row.
  EICAR-style payloads are quarantined; clean payloads stay live.
  The same path works under stub adapters for dev/test.
- **Public NHCX webhook is now signature-gated** — production
  deployments that set `NHCX_INBOUND_VERIFY_SIGNATURE=true` reject
  unsigned, replayed (>300s skew), or impostor-keyed callbacks with
  401 before the JWE is even decrypted. JWE remains the cryptographic
  guarantee on origin; the signature is the cheap-to-check edge.
- **Tenant secrets at rest** — `tenant.commsConfig.smtp.password`
  and `tenant.commsConfig.sms.apiKey` are AES-256-GCM-wrapped under
  per-tenant DEKs derived via HKDF from the same root key as PII.
  CLAUDE.md hard-rule #9 is now satisfied for this credential class.
- **Operator-driven remittance reconciliation** — payer remittance
  CSV → paste → preview → apply. Per-row outcomes (applied / short-
  paid / unmatched / failed) surface in the UI with colour-coded
  badges; `bankTxnId` lands on the `Settlement` row so finance can
  reconcile back to the originating bank line item.
- **SMS notifications go to a real gateway** — tenants on
  `provider=textguru` route through a real HTTP POST instead of a
  log stub. Failures throw, the upstream `notification_outbox` row
  flips to `failed`, the surrounding API request still succeeds.

## Open questions for the user

1. **Close Sprint 5 here, or push another slice?** — the slice-
   sized backlog from the Sprint 4 exit doc is mostly consumed
   (auto-chain ✓, KMS comms ✓, real ClamAV ✓, real TextGuru ✓,
   HCX HTTP sig ✓, payer remittance ✓). What's left (real OVH KMS,
   BullMQ, PMJAY, EOB OCR) is multi-slice or external-dependency.
   Time to plan Sprint 6 axis explicitly?
2. **PMJAY priority** — Sprint 4 shipped a complete NHCX loop; the
   platform's other major rail (PMJAY / Ayushman Bharat) is
   unaddressed. How many tenants need PMJAY in the v1 launch
   window? That sets whether Sprint 6 starts there or elsewhere.
3. **Real OVH KMS or stay on env-supplied root key?** — the
   stub-mode root key works in production today. Real OVH KMS adds
   audit + rotation + IAM-bounded access, but means an OVH ticket
   to provision the CMK. Which regulatory ask is forcing the
   timing — compliance signoff, or operational?
4. **EOB OCR vendor selection** — Textract, Google Document AI,
   AWS Comprehend Medical, or a domain-specific Indian-claims OCR
   provider? Each has different per-page costs + EHR-bundle
   recognition + Hindi/English handling.

## Sprint 6 likely shape

Not committed. The candidates that remain after Sprint 5:

- Real OVH KMS wrap of the PII + comms root key (rotation tooling
  + IAM-bounded access).
- BullMQ-on-Redis for notifications + scan worker (replaces the
  in-process retry/poll loops).
- PMJAY rail adapter (sub-system; multiple slices).
- EOB OCR vendor + extraction pipeline.
- Inbound rate-limiting + abuse signals on `/nhcx/inbound`.
- Real-clamd e2e harness (testcontainers clamd + MinIO).
- Additional NHCX inbound message types (`insuranceplan`,
  `paymentnotice`, `task`).
- Audit log retention + archival policy.

Sprint 6 axis decision pending the user's call (see Open questions).
