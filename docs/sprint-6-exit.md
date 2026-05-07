# Sprint 6 — Exit document

Sprint window: started after PR #52 (Sprint 5 paperwork pause)
merged on 2026-05-07; this doc is written at the Sprint 6
paperwork pause on 2026-05-07 with PR #63 (Slice BD) on `main`.

## What shipped

Eleven slices on top of the Sprint 5 production-hardening surface.
Theme in two halves:

1. **Closing real-mode integration loops.** Sprint 5 stood up the
   real adapters (ClamAV, TextGuru, KMS-wrapped comms, HTTP
   signature on inbound, JWE all the way through). Sprint 6 made
   those adapters _useful_ end-to-end — rate-limited the public
   webhook (AT), proved the ClamAV adapter against a real clamd
   in CI (AU), shipped the entire EOB-OCR pipeline from adapter
   skeleton to operator-facing extract-and-apply on the
   settlement screen (AV–BB), and added presigned downloads so
   operators can verify what they uploaded before trusting the
   OCR (AZ).
2. **Completing the HCX 0.7.1 inbound protocol surface.** Slice
   Z established the dispatcher in Sprint 4; BC and BD round it
   out — gateway-pushed PaymentNotices auto-flip claims to
   `PAYMENT_RECEIVED` / `SHORT_PAID` without operator action, and
   the remaining message types (`insuranceplan/on_request`,
   `task/on_submit`) are recorded in the ledger so CLAUDE.md
   hard-rule #7 is fully satisfied.

| Slice | Theme                                                          | PR  |
| ----- | -------------------------------------------------------------- | --- |
| AT    | Inbound rate limit on `/nhcx/inbound`                          | #53 |
| AU    | Real-clamd integration test via testcontainers                 | #54 |
| AV    | `EobOcrAdapter` skeleton + stub                                | #55 |
| AW    | `POST /documents/:id/eob-extract` endpoint                     | #56 |
| AX    | Real `HttpEobOcrAdapter` (multipart to inference service)      | #57 |
| AY    | Settlement-screen EOB extract + receivedAmount pre-fill        | #58 |
| AZ    | Presigned `GET /documents/:id/download-url`                    | #59 |
| BA    | Settlement polish — bankTxnId / shortPaymentReasons + View     | #60 |
| BB    | Reconcile UI with editable deduction lines                     | #61 |
| BC    | `paymentnotice/request` inbound handler                        | #62 |
| BD    | `insuranceplan/on_request` + `task/on_submit` (log-only)       | #63 |

See `CHANGELOG.md` for per-slice detail. (This sprint shipped
CHANGELOG entries in-PR per the discipline saved as a feedback
memory after Slice AS — no backfill chore needed this time.)

## Test coverage at exit

| Suite (representative)                            | Cases | Notes                                                         |
| ------------------------------------------------- | ----- | ------------------------------------------------------------- |
| `nhcx-inbound-rate-limit.guard.spec`              |   7   | Slice AT — fake-timer fixed-window counter                    |
| `clamav-real.e2e`                                 |   3   | Slice AU — real clamd via testcontainers                      |
| `stub-eob-ocr.adapter.spec`                       |   8   | Slice AV — sentinel-pattern fixtures                          |
| `eob-extract.e2e`                                 |   4   | Slice AW — endpoint + scope guards                            |
| `http-eob-ocr.adapter.spec`                       |  12   | Slice AX — request shape + 8 failure modes + storage path     |
| `document-download-url.e2e`                       |   3   | Slice AZ — presigned download                                 |
| `fhir-response-parsers.spec` (BC/BD additions)    |  16   | 8 PaymentNotice + 4 InsurancePlan + 4 Task                    |
| `paymentnotice-inbound.e2e`                       |   3   | Slice BC — gateway push → state transition                    |
| `inbound-aux-messages.e2e`                        |   2   | Slice BD — log-only auxiliary messages                        |
| **Sprint 6 additions**                            | **~58** | On top of the existing ~337 cases from Sprints 1–5         |

Full suite at exit: **~39 spec files, ~213 cases** integration;
**~265 cases** unit. CI now also boots a real clamd container per
integration run (~30s overhead amortised across the whole suite).

## Decisions worth remembering

- **HCX inbound message types fall into three response shapes
  (BC / BD / Slice Z–AF).** The dispatcher in
  `nhcx-inbound.service.ts` is the canonical place to look at how
  each one's resolved:
    1. **Phase callback with matching outbound** (eligibility,
       preauth, claim/on_submit, paymentnotice/request) — tenant
       + claim resolved from the outbound row, parsed payload
       drives a state transition or settlement write through the
       owning service.
    2. **Communication/request** — disambiguated three ways via
       `lookupOutboundOperation` (Slice AF): discharge ack,
       query response ack, or payer-initiated query. Pattern is
       reusable for any future "polymorphic operation".
    3. **Log-only with no transition** (insuranceplan, task) —
       parse, record, attach summary; the integration_message row
       is the audit trail and downstream consumers of the ledger
       can act on it later. New message types deferred for "no
       operational pressure" land here by default.
- **TS-side stack vs. inference service split (Slice AX).** The
  HTTP-based real EOB OCR adapter defines a small contract — POST
  multipart `/extract`, response is `{ status, engine, fields?,
  error? }` — and **any** service that conforms can plug in. Reference
  impl is a Python sidecar wrapping PaddleOCR / Surya + Qwen2-VL
  / GOT-OCR2.0; tenants can run their own per-payer extractors.
  Defensive parsing on the TS side means a sloppy upstream can't
  poison downstream persistence.
- **Operator UX: extract → review → apply (Slices AY, BA, BB).**
  We deliberately don't auto-fill the receipt form on upload.
  Operator clicks Extract, reviews the parsed summary
  (`ExtractSummary` block), clicks Record receipt only if the
  values look right. Same deductions carry through from
  `PAYMENT_PENDING` extract to `PAYMENT_RECEIVED` reconcile via
  component-mounted state — no fetch round-trip, no DB
  persistence yet (auto-fill of a draft Settlement on extract is
  a future API-side follow-up).
- **`actorUserId: string | null` in service-input shapes (BC).**
  Gateway-driven calls write `claim_event` rows with no operator
  attached. We've now typed three service inputs this way
  (preauth/claim-submit/discharge from Sprint 4, settlement from
  BC). Future "system-driven" service entry points should follow
  the same shape.
- **View-then-extract is a UX trust-loop (Slices AY + AZ + BA).**
  Operators won't trust auto-extracted fields without a way to
  see the source document. AZ wired the presigned-URL view-link
  before BA pre-filled more fields. Watchword: when shipping
  auto-extract or AI-driven UX, ship the verification affordance
  in the same window or sooner — not as a follow-up.
- **Per-PR CHANGELOG discipline held this sprint.** Saved as
  feedback memory after the Sprint 5 backfill chore (PR #51).
  Sprint 6 didn't need a backfill — every slice PR included its
  CHANGELOG entry. Memory paid back immediately.

## Bugs caught during the sprint

- **Slice AU clamd-readiness false positive.** Wait strategy
  matched on the "Listening daemon" log line, which fires before
  the signature DB finishes loading. Connections in that window
  got `ECONNRESET`. Fix: replace the log strategy with a
  TCP-level `zPING`/`PONG` handshake. Saved as a pattern for any
  future testcontainer that has a "real" readiness signal beyond
  log lines.
- **Slice AZ regex char-class corruption via Write.** Wrote a
  sanitiser regex with `\xNN` hex escapes for control bytes; the
  Write tool inserted the escape's literal byte values into the
  file (NUL + 0x1F), which Edit then couldn't match because the
  display rendered the bytes as if the escapes were still there.
  Fix: never put hex escapes for control bytes inside a regex
  written through Write — use `\uNNNN` or a simpler pattern.
  Saved as a feedback memory.

## Deferred to Sprint 7

| Item                                                              | Why deferred                                                                                                    |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Real OVH KMS for the PII + comms root key                         | Stub-mode env-supplied root key is acceptable until OVH KMS credentials are provisioned. AP wrap-format ready.  |
| BullMQ-on-Redis for notifications + scan worker + rate-limit      | The current in-memory polling/counter loops are correct, just single-replica. Multi-replica needs Redis backing. |
| PMJAY rail adapter                                                | Per `docs/07`, this is a portal-automation problem (per-state YAML flows + Playwright), not a clean API. Multi-slice; needs design pass. |
| EOB OCR auto-fill of a draft Settlement                           | Today AY pre-fills the receipt form in component state; persisting an `EobExtraction` row + auto-creating a draft Settlement is a follow-up. |
| Per-payer EOB extractor routing                                   | The AX adapter contract is single-service; operators may eventually want different extractors per payer (different EOB layouts). |
| Audit log retention + archival                                    | Compliance-sensitive — needs explicit policy direction (RBI / DPDP retention vs. operational pruning).          |
| Document checksum verification on finalize                        | S3 stores `ChecksumSHA256` on PUT; reading it back at finalize would catch truncated uploads. Hardening item.   |
| Health endpoint deep-readiness probes                             | `/health/ready` checks DB + migrations only. Real-mode deployments would benefit from probes for ClamAV / OCR / Redis. |
| Notification outbox viewer                                        | Operators currently can't see whether SMS/email actually sent. Useful for deliverability debugging.             |
| `parseClaimResponse` extracts identifier (Slice AE follow-up)     | Synchronous claimRefNum stamping at QUEUED works in production. Cosmetic refactor.                              |

## Operational artefacts

- **Document → settlement loop is end-to-end on the operator UI.**
  Upload EOB → View (presigned URL, AZ) → Extract (AW, against
  AX inference service) → review extracted fields (AY/BA/BB) →
  Record receipt → Reconcile with deductions → Close. Each step
  has either an explicit operator click or a clear status badge;
  operators never see "auto-applied" magic without a way to
  audit.
- **Settlement loop is also driven by gateway push.** Slice BC's
  PaymentNotice handler bypasses the operator entirely for the
  happy path: gateway settles → claim auto-flips to
  `PAYMENT_RECEIVED`/`SHORT_PAID` with `bankTxnId` persisted.
  Operators can still drive the same path manually
  (AL remittance batch or AY+BA receipt form) when a payer
  doesn't push notices.
- **HCX 0.7.1 inbound surface is feature-complete.** All seven
  operations the gateway can push are routed:
  `coverageeligibility/on_check`, `preauth/on_submit`,
  `claim/on_submit`, `communication/request`,
  `paymentnotice/request`, `insuranceplan/on_request`,
  `task/on_submit`. The first five drive transitions; the last
  two log + record. CLAUDE.md hard-rule #7 (audit both
  directions of every external integration) is now fully met.
- **EOB OCR contract is in two pieces.** TS side is shipped (AV
  adapter + AW endpoint + AX HTTP-inference adapter + AY/BA/BB
  UI). The Python inference service implementing the
  multipart-`/extract` contract — PaddleOCR / Surya + Qwen2-VL /
  GOT-OCR2.0 — is an infra task in a separate repo. Tenants can
  also run their own per-payer extractors that conform.

## Open questions for the user

1. **Stand up the Python inference service?** AX wired the TS
   side end-to-end against a documented multipart contract.
   `EOB_OCR_MODE=real` will work the moment we point
   `EOB_OCR_INFERENCE_URL` at a service that conforms. Building +
   hosting the reference Python sidecar is the next concrete step
   — different repo, different priorities, different ops surface.
2. **PMJAY: portal automation or wait for an HCX-style API?**
   `docs/07` describes PMJAY as a portal-automation problem with
   per-state YAML flows. Going down that road is a multi-week
   sub-project. The alternative is to wait for NHA to publish a
   PMJAY HCX-shaped API (rumoured but not committed). What's the
   v1 launch posture?
3. **Sprint 7 axis.** With the EOB-OCR thread closed and the HCX
   0.7.1 inbound surface complete, the next major axis is open.
   Candidates: BullMQ migration (multi-replica readiness),
   PMJAY (per above), real OVH KMS, audit retention. Or a
   different direction the user has in mind.

## Sprint 7 likely shape

Not committed. Candidates after Sprint 6:

- BullMQ-on-Redis migration — replaces in-memory retry/polling
  workers + the AT rate-limit counter with Redis-backed
  primitives. Multi-replica readiness.
- Real OVH KMS for PII + comms root keys (rotation tooling +
  IAM-bounded access).
- PMJAY rail adapter (per-state YAML flow runner; needs a design
  pass before any code).
- EOB OCR auto-persist + per-payer extractor routing (TS side).
- Health endpoint deep-readiness probes for real-mode adapters.
- Audit log retention / archival policy.
- Document checksum verification on finalize (S3
  ChecksumSHA256).
- Notification outbox viewer for ops deliverability debugging.

Sprint 7 axis decision pending the user's call.
