# Sprint 4 — Exit document

Sprint window: started after PR #28 (Slice Y / FHIR snapshot lock)
merged on 2026-05-06; this doc is written at the Sprint 4 paperwork
pause on 2026-05-07 with PR #39 (Slice AI) on `main`.

## What shipped

Ten slices on top of the Sprint 3 production-hardening surface.
Theme: close the NHCX integration loop. Sprint 2 / 3 only shipped
outbound NHCX traffic; Sprint 4 wires inbound webhooks, threads FHIR
enrichment through every phase, flips all four NHCX outbound flows
to callback-driven in real mode, and adds the appeal lifecycle that
the state machine has been waiting on since Sprint 2.

| Slice | Theme                                                              | PR  |
| ----- | ------------------------------------------------------------------ | --- |
| Z     | NHCX inbound webhook + FHIR response dispatcher                    | #30 |
| AA    | FHIR R4 enrichment for preauth / discharge / claim / communication | #31 |
| AB    | OpenAPI spec + Swagger UI mount                                    | #32 |
| AC    | Eligibility callback-driven in real mode                           | #33 |
| AD    | Preauth callback-driven in real mode                               | #34 |
| AE    | Claim-submit callback-driven in real mode                          | #35 |
| AF    | Discharge callback-driven in real mode                             | #36 |
| AG    | Sender-code allowlist on /nhcx/inbound                             | #37 |
| AH    | Appeal lifecycle (API + Prisma model)                              | #38 |
| AI    | Appeal panel on case detail (web)                                  | #39 |

See `CHANGELOG.md` for per-slice detail.

## Test coverage at exit

| Suite (representative)                              | Cases | Notes                                                    |
| --------------------------------------------------- | ----- | -------------------------------------------------------- |
| `fhir-response-parsers.spec`                        |  15   | Slice Z — pure-function parsers                          |
| `nhcx-inbound.e2e`                                  |   6   | Slice Z — webhook end-to-end                             |
| `nhcx-fhir-enrichment.e2e`                          |   6   | Slice AA — orchestrator → adapter wiring                 |
| `openapi.spec`                                      |   2   | Slice AB — spec validity + disable flag                  |
| `eligibility-callback-driven.e2e`                   |   1   | Slice AC — real-mode round trip                          |
| `preauth-callback-driven.e2e`                       |   1   | Slice AD — two-step ack + decision                       |
| `claim-submit-callback-driven.e2e`                  |   1   | Slice AE — full pipeline                                 |
| `discharge-callback-driven.e2e`                     |   1   | Slice AF — communication/request disambiguation          |
| `nhcx-sender-allowlist.service.spec`                |   6   | Slice AG — unit                                          |
| `nhcx-inbound-sender-allowlist.e2e`                 |   5   | Slice AG — integration                                   |
| `appeal.e2e`                                        |   8   | Slice AH — start/submit/resolve + RBAC + state-machine   |
| **Sprint 4 additions**                              | **~52** | On top of the existing ~225 cases from Sprint 1-3      |

The CI gate now runs the full real-mode round-trip against an
in-process mock NHCX gateway in addition to the previous suites.
Total integration suite at exit: **~36 spec files, ~205 cases**.

## Decisions worth remembering

- **Default-permit allowlist semantics (Slice AG)** — when the
  allowlist source is empty (e.g., a test rig without seeded
  payers), every sender is allowed. Production deployments seed at
  least one payer, so enforcement kicks in automatically. Avoids
  the chicken-and-egg problem of having to seed a payer before any
  test can run. Generalises to any future "validate-against-master-
  data" check.
- **`err.constructor.name` for failure classification (Slice Z fix)**
  — `err.name` returns whatever the parent class declared
  (`DomainError`), not the actual concrete class
  (`InvalidClaimTransitionError`). The classifier needs the latter
  to map state-machine rejections correctly. Watchword for any
  future error-bucketing code.
- **`NHCX_MODE` gates orchestrator behaviour, not just adapter
  selection (Slices AC–AF)** — in real mode the orchestrator stops
  at the "queued" / "pending" state and lets the gateway callback
  drive the next transition. In stub mode the orchestrator
  auto-advances because no callback ever fires. The gating is a
  single `if (config.get('NHCX_MODE')) === 'real'` per phase
  service; the callback-side `handleInboundResponse` handles both
  paths (skips the ack when the claim is already past the
  intermediate state).
- **Idempotency keyed on `(correlationId, direction, operation)`
  (Slice Z fix)** — Slice K's orchestrator writes a synthetic inbound
  row in stub mode with the outbound operation name (e.g.
  `eligibility.verify`). The gateway-callback inbound uses the HCX
  operation name (e.g. `coverageeligibility/on_check`). Filtering
  on operation lets both coexist without collision.
- **`200 + outcome on the row` for inbound rejections (Slice AG)**
  — when a callback is rejected (sender not in allowlist, no
  matching outbound, malformed JWE), the controller still returns
  200 to the gateway so NHA doesn't retry on a configuration
  mismatch. The integration_message row carries the failureClass
  for ops forensics. This is the right shape for any inbound
  webhook we add later.
- **Appeal stays bounded to `appeal.*` events (Slice AH)** — the
  service deliberately doesn't auto-chain into settlement.
  Operators run `/settlement/expect` (favourable resolution) or
  `/settlement/write-off` (unfavourable) afterwards. Keeps the
  service boundary clean; auto-chain is a Sprint 5 backlog item.
- **`@nestjs/swagger@7` not v11 (Slice AB)** — v11+ expects a
  `@nestjs/core/router/legacy-route-converter` path that doesn't
  exist in pinned 10.3.9. Watchword for Nest version compatibility:
  upgrade `@nestjs/core` first, then `@nestjs/swagger`.
- **In-process mock gateway pattern (Slices AC–AF)** — Slice P
  established the pattern; AC–AF reuse it to test real-mode flows
  without standing up an NHCX sandbox. Each test starts a Node
  HTTP server that decrypts with the gateway private key + responds
  with a JWE encrypted to the participant's public key. The pattern
  is the right shape for any future "test against the real-mode
  adapter" need.

## Bugs caught during the sprint

- **Slice Z polling timeout** — `claims_migrator` doesn't BYPASSRLS,
  so bare findFirst from the test returned nothing. Fixed by
  wrapping reads in a $transaction that sets `app.role='platform_
  admin'`. Pattern reused in every callback-driven integration test.
- **Slice Z idempotency collision** — Slice K's synthetic inbound
  row collided with the gateway-callback inbound on (correlationId,
  direction='inbound'). Fixed by filtering on operation too.
- **Slice Z RLS-blocked service reads** — service was reading
  integration_message outside any tenant context; wrapped all reads
  + writes in platform_admin `$transaction`.
- **Slice Z failure classification** — `err.name` reports parent
  class. Fixed via `err.constructor.name`.
- **Slice AE claimRefNum stamping** — inbound dispatcher couldn't
  patch claimRefNum because parseClaimResponse doesn't extract it.
  Fixed by stamping synchronously at the QUEUED step (Sprint 5
  follow-up: extend the parser).
- **Slice AF / AE test interaction** — AF flipped discharge to
  callback-driven; AE's existing test relied on the old synchronous
  auto-transition. Fixed by firing the discharge callback in AE's
  test as part of AF's PR.

## Deferred to Sprint 5

| Item                                                                | Why deferred                                                                            |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Auto-chain favourable appeal resolution → settlement.expectPayment  | Slice AH explicitly kept the boundary clean. Operator UX win, not a correctness fix.    |
| Extend `parseClaimResponse` to extract identifier                   | Slice AE works around it by stamping claimRefNum synchronously.                         |
| HCX inbound HTTP signature (JWS-on-JWE)                             | Spec-pending — NHA hasn't mandated a specific signature scheme yet.                     |
| NHCX inbound for additional message types (insuranceplan, paymentnotice, task) | Pattern is clear from Slice Z + AF; no operational pressure yet.       |
| Real OVH KMS / ClamAV / TextGuru                                    | All Sprint 5 hardening items — interface stubs exist; production wiring needs creds.    |
| Per-controller `@ApiTags` polish (17 controllers)                   | Cosmetic; auto-generated tags are functional today.                                     |
| Real job queue for inbound processing                               | Fire-and-forget is OK at low volume; not a correctness issue.                           |
| Decoupled processing per HCX 0.7.1 spec                             | Same as job queue — production hardening.                                               |
| Settlement maturity (EOB OCR, payer remittance reconciliation)      | Each is its own slice; OCR needs a real provider integration (Textract / Document AI).  |
| PMJAY rail adapter                                                  | Net-new integration; needs SHA + state-by-state mode routing scoping.                   |

## Operational artefacts

- `/api/docs` (Swagger UI) + `/api/docs-json` (raw OpenAPI 3 spec)
  are the API documentation surface. The web team + future
  external integrators get a generated client + self-describing
  contract for free.
- `IntegrationMessage` ledger now records every inbound + outbound
  NHCX message both ways. Operators trace correlation chains by
  the same correlationId across `direction='outbound'` and
  `direction='inbound'`.
- `Payer.hcxCode` is the source of truth for the inbound sender
  allowlist. Adding / deactivating a payer cycles enforcement
  inside one cache TTL (60s) without code changes.
- `Appeal` table is the audit trail for every appeal cycle. RLS
  matches the rest of the schema; cross-tenant invisibility verified
  by the existing canary suite + by the new appeal.e2e-spec.

## Open questions for the user

1. **Sprint 4 axis** — was the "complete the NHCX loop" focus the
   right call, or should we have pivoted to settlement / PMJAY
   sooner? Ten slices in one rail is a lot.
2. **HCX signature** — wait for NHA to mandate a specific scheme,
   or implement a defensive HMAC-SHA256-on-body header now (knowing
   we'll rip it out)?
3. **Auto-chain post-appeal** — Slice AH was deliberately
   bounded; do operators actually want the click-saving auto-chain,
   or does the explicit two-step (resolve → expect / write-off)
   match how they think about it?
4. **NHCX inbound message types we haven't wired** — `insuranceplan
   /on_request`, `paymentnotice/request`, `task/on_submit`. Is any
   of these blocking a near-term go-live?

## Sprint 5 likely shape

Not committed yet. Sprint 5 was always slated as production
hardening; the candidates that surfaced during Sprint 4:

- Real OVH KMS for the PII root key (Slice R follow-up).
- KMS-wrap of `commsConfig` secrets (Slice X follow-up).
- Real ClamAV (Slice S follow-up).
- Real TextGuru SMS (Slice X follow-up).
- HCX inbound HTTP signature header.
- Auto-chain post-appeal favourable resolution into settlement.
- Real job queue (BullMQ on existing Redis) for inbound processing.
- PMJAY rail adapter as a separate integration.
- EOB OCR via Textract / Document AI.
- Payer remittance reconciliation.

Sprint axis decision pending the user's call (see Open questions).
