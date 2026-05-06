# Sprint 2 — Exit document

Sprint window: started after PR #9 (Sprint 1 exit) merged in early May
2026; closed at PR #20 (Slice Q). Backfilled retrospectively as part of
the Sprint 3 exit cleanup.

## What shipped

Nine slices, each a standalone PR landing on `main` with green CI.
Theme: lift the Sprint 1 auth skeleton into the actual claims business
domain (case → preauth → discharge → claim → settlement) and replace
the first batch of dev stubs with real network adapters.

| Slice | Theme                                                              | PR  |
| ----- | ------------------------------------------------------------------ | --- |
| I     | Event-sourced claim aggregate engine                               | #10 |
| J     | Case + claim CRUD over HTTP                                        | #11 |
| K     | NHCX-stub eligibility cycle + integration_message ledger           | #12 |
| L     | Pre-auth phase end to end                                          | #13 |
| M     | Discharge + claim submit phase end to end                          | #14 |
| N     | Settlement: payment, EOB, reconciliation, write-off                | #15 |
| O     | Master data: payer, package, ICD, billing, checklist               | #16 |
| P     | Real NHCX JWE adapter + mode switch                                | #17 |
| P2    | S3 presigned upload pipeline                                       | #18 |
| P3    | Real ABDM HPR adapter + two-step OTP flow                          | #19 |
| Q     | Security headers + retry worker + readiness probe                  | #20 |

(P / P2 / P3 share a sprint letter because they all swap "Sprint 1
stub → real network adapter" for one specific integration.)

See `CHANGELOG.md` for per-slice detail.

## Test coverage at exit

Approximate count, since coverage was added incrementally and some
files were rewired between slices. Sprint 2 closed with **~25 integration
spec files / ~150 cases** plus the unit-test suite (~70 cases).

| Slice | Suite (representative)                            | Cases |
| ----- | ------------------------------------------------- | ----- |
| I     | `claim.state-machine.spec` + `claim-engine.e2e`   | 11+6  |
| J     | `case-claim.e2e`                                  | 8     |
| K     | `eligibility-cycle.e2e`                           | 6     |
| L     | `preauth-cycle.e2e`                               | 7     |
| M     | `discharge-claim-submit.e2e`                      | 7     |
| N     | `settlement.e2e`                                  | 7     |
| O     | `master-data.e2e`                                 | 7     |
| P     | `nhcx.crypto.spec` + `nhcx-jwe-adapter.e2e`       | 3+4   |
| P2    | `storage-stub.spec` + `document-upload.e2e`       | 2+4   |
| P3    | `hpr-stub.spec` + `hpr-real-adapter.e2e`          | 5+5   |
| Q     | `security-headers.spec` + `retry-worker.spec` +   |       |
|       | `health.e2e`                                      | 4+6+4 |

Sprint 1's full integration suite (RLS canary, auth, MFA, sessions,
doctor, onboarding, lifecycle) continues to gate every PR.

## Decisions worth remembering

- **Adapter call outside the Postgres tx (Slice K)** — orchestrators
  open a tenant tx, transition to a "requested" state, commit; only
  THEN call the adapter; THEN reopen a tx to write the inbound ledger
  row + final transition. Holding a tx open across a network round-trip
  is the kind of mistake you can only make once before someone pages
  you. Eligibility, preauth, discharge, claim-submit all follow the
  same shape.
- **Submit snapshot in `submittedSnapshot` JSONB (Slice L)** —
  per-field state captured at submit time so a subsequent edit to the
  draft can't silently change what we believe we sent to the payer.
  The draft edits while the claim is `DRAFTING`; once `SUBMITTED` the
  snapshot is the source of truth for what crossed the wire.
- **`finalAmount` on the wire at claim submit (Slice M)** — the
  pre-auth amount is the patient's pre-authorised cap; what the
  hospital actually bills (`finalAmount`) can differ once the
  discharge package is finalised. Wiring `finalAmount` separately
  avoids a class of "we silently undercharged the payer" bugs.
- **Master data is platform-level, not tenant-scoped (Slice O)** —
  payer / package / ICD / billing / checklist are catalogues every
  tenant reads from, not per-tenant configuration. RLS opens SELECT
  to any authenticated context but locks edits to `platform_admin`.
- **Mode switch via `*_MODE=stub|real` + boot-time validation
  (Slice P / P2 / P3)** — every external adapter has a `MODE` env. Real
  mode requires the connection envs; the config loader rejects boot
  rather than the first request. Stub remains the dev / test default
  so non-prod environments don't have to mint real credentials.
- **Hand-rolled security headers, not helmet (Slice Q)** — every
  header in `security-headers.middleware.ts` is auditable in one place.
  Helmet's defaults change between major versions; we'd rather hold the
  policy explicitly than chase a CVE-driven dependency bump that
  silently relaxes our CSP.
- **Notification retry worker is idempotent at the recipient level
  (Slice Q)** — every API instance ticks; if two pick the same row
  only the first `update` wins (Postgres row-lock). Worst case is one
  row delivers twice. Email + SMS adapters tolerate that, which is
  why we don't pay for a stronger lock.

## Deferred to Sprint 3

| Item                                                                 | Why deferred                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Encrypted patient PII (Aadhaar / ABHA / mobile / email)              | Slice I noted plaintext patient placeholder — wired into Slice R.                     |
| Atomic `Case + Claim` creation                                       | Slice J calls into `ClaimService.create` which opens its own tx. Wrap in Slice R.    |
| Document virus-scan + lifecycle                                      | Slice P2 added the upload pipeline. Scanning + stale-pending sweep in Slice S.        |
| Real FHIR R4 bundles for NHCX                                        | Slice P shipped the JWE wrapper around freeform JSON. FHIR shape lands in Slice T.    |
| ABDM token cache + NHCX key rotation                                 | Slice P / P3 ship single-key + per-request mint. Production hardening in Slice U.     |
| Audit log viewer + CSV export                                        | Audit pipeline since Slice A; UI + export only in Slice V.                            |
| Real-MinIO S3 round-trip tests                                       | Slice P2's integration tests cover happy path against the stub. Real MinIO in W.      |
| Per-tenant SMTP / SMS                                                | Slice Q's retry worker ships platform-default SMTP only. Per-tenant in Slice X.       |
| FHIR builder snapshot lock                                           | Slice T ships the builders; snapshot harness in Slice Y.                              |
| OVH KMS for tenant secrets                                           | Slice X stores SMTP password + SMS apiKey in plaintext-on-RLS. KMS-wrap in Sprint 5.  |
| Real ClamAV virus-scan                                               | Slice S ships EICAR stub. Real INSTREAM in Sprint 5.                                  |
| Real TextGuru SMS HTTP                                               | Slice X ships logging stub. Real provider in Sprint 5.                                |

## Operational artefacts

- `IntegrationMessage` ledger now backs every external call. Operators
  can grep by `correlationId` to trace a single request across
  outbound + inbound rows.
- `/health/ready` is now a real LB-driven probe — pulls instances out
  of rotation while migrations are mid-flight or rolled back.
- All migrations apply cleanly in CI on every PR via testcontainers
  Postgres + `prisma migrate deploy`. The integration runner now also
  spins up MinIO via testcontainers (added in Slice W during Sprint 3,
  but the harness pattern was set in Sprint 2's testcontainers usage).

## Open questions for the user (still open at exit)

1. PMJAY rail — Sprint 2 left the `primaryRail='pmjay'` code path
   stubbed at the eligibility / submit layer. Do we wire a real
   PMJAY adapter or keep the rail rail-toggled-off until production?
2. Integration message retention — every external call writes two
   rows. At the volume we expect post-launch, do we keep them
   indefinitely (compliance argument) or set a 12-month TTL?
3. `claim_event` rollups — the event log is the source of truth.
   Once we have 6+ months of LIVE traffic, do we materialise weekly
   aggregates for analytics, or keep replaying the full log?

## Sprint 3 likely shape (which is what shipped)

- Encrypted PII (Slice R), virus-scan + lifecycle (Slice S), real FHIR
  R4 bundles (Slice T), token cache + key rotation (Slice U), audit
  viewer (Slice V), real-MinIO tests (Slice W), per-tenant SMTP / SMS
  (Slice X), FHIR snapshot lock (Slice Y).

See `docs/sprint-3-exit.md` for what actually landed.
