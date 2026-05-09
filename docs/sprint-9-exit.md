# Sprint 9 — Exit document

Sprint window: started after PR #84 (Sprint 8 exit doc) merged on
2026-05-09; this doc is written at the Sprint 9 paperwork pause on
2026-05-09 with PR #89 (Slice CE) on `main` plus the parallel Python
repo (`eob-ocr-machine` at SHA `573f62b`) carrying the OCR-side
per-payer detection that mirrors the TS work.

## What shipped

Five slices on the TS side, plus the OCR-side detection port. The
sprint scope projected at Sprint 8 exit (per-payer extractors +
perf hardening + parallel Python OCR) all landed; hard consent
enforcement remains deferred behind a tenant-level
`requireConsent` flag (Slice CB shipped the threading; turning on
hard enforcement is a follow-up gated on consent capture being
wired into intake).

| Slice | Theme                                                                       | PR  |
| ----- | --------------------------------------------------------------------------- | --- |
| CA    | Per-payer EOB extractor framework + Star Health + Bajaj Allianz             | #85 |
| CB    | Thread `consentGrantId` through `FhirContextService.build` (soft binding)   | #86 |
| CC    | Production cron wiring (retention sweep + breach scan via pg_cron / k8s)    | #87 |
| CD    | Composite indexes for BU dashboard queries                                  | #88 |
| CE    | Top-4 remaining payer extractors (ICICI Lombard, HDFC Ergo, Mediassist, Paramount) | #89 |

Plus, in the parallel `eob-ocr-machine` repo:

| SHA      | Theme                                                                                  |
| -------- | -------------------------------------------------------------------------------------- |
| `bb4813f`| OCR machine v0 bootstrap — FastAPI scaffold + sentinel-recognising stub                |
| `573f62b`| Per-payer detection ported from TS (mirrors CA + CE signatures)                        |

See `CHANGELOG.md` for per-slice TS detail. Per-PR CHANGELOG
discipline held throughout.

## Test coverage at exit

| Suite (representative)                                   | Cases | Notes                                                         |
| -------------------------------------------------------- | ----- | ------------------------------------------------------------- |
| `star-health.extractor.spec` (CA)                        |   8   | Detect signals + canonical mapping + unknown fallback         |
| `bajaj-allianz.extractor.spec` (CA)                      |   8   | Detect signals + canonical mapping                            |
| `payer-extractor.service.spec` (CA + CE)                 |   9   | Registry routing across all 6 + tie-breaks + TPA detection    |
| `icici-lombard.extractor.spec` (CE)                      |   9   | Detect signals + room-rent capping → sublimit specific rule   |
| `hdfc-ergo.extractor.spec` (CE)                          |   9   | Detect signals + Reasonable & Customary copy variants         |
| `mediassist.extractor.spec` (CE)                         |   9   | TPA name regex variants + consumables-and-disposables rule    |
| `paramount.extractor.spec` (CE)                          |   9   | Co-share + investigation-in-progress mapping                  |
| `consent-binding-on-decrypt.e2e` (CB)                    |   3   | Bound consent / null binding / PMJAY type mismatch            |
| `audit-retention-sweeper.e2e` (CC additions)             |   1   | Sweeper runs cleanly under the new retention_sweeper GUC role |
| `compliance-dashboard.e2e` (CD additions)                |   1   | Composite index hit verified via EXPLAIN snapshot             |
| **Sprint 9 TS additions**                                | **~66** | On top of ~563 cases from Sprints 1–8                       |
| Python `test_payer_detect.py` (OCR repo)                 |  29   | Per-prefix + per-name-regex + tie-breaks + TPA fallback       |
| Python `test_extract.py` (OCR repo)                      |  10   | Sentinel paths + auth + size-cap + multipart shape            |
| **Python total**                                         | **39** | Solo repo, no monorepo CI gate yet                           |

Full suite at TS exit: **~57 spec files** integration; **~58
cases** unit + ~5 cases integration added this sprint. Heap ceiling
held at 4 GB — CD's index work nudged retention-class pastFloor
queries off table-scan onto index-scan (verified via `EXPLAIN` in
the BU e2e), which is what kept the suite from approaching the
ceiling.

## Decisions worth remembering

- **Per-payer normalisation is a TS-side concern; per-payer
  prompt tuning is a Python-side concern.** CA + CE shipped
  regex-based detection + canonical-category mapping in TS. The
  OCR machine pre-detects via the same regex signatures (ported
  to Python in `eob-ocr-machine/app/extractors/payer_detect.py`)
  so when v1's PaddleOCR + Qwen2-VL pipeline lands, the layout
  model can route to payer-specific prompts using a result the
  TS framework already trusts. **Detection signatures must stay
  in lockstep across the two repos** — divergence produces
  different `payerCode` for the same EOB, which surfaces as
  weird category mappings on the settlement screen. Treat any
  change to the regexes as a coordinated two-PR change.
- **Soft consent binding ships ahead of hard enforcement.** CB
  threads `consentGrantId` from `FhirContextService.build` into
  `PatientService.getDecrypted` ctx so every decrypt event in the
  preauth / claim-submit / discharge / eligibility paths binds
  back to the active consent grant. When no grant exists, the
  read still proceeds and the access-ledger row records
  `consentGrantId=null` — which BU's dashboard surfaces as
  "unbound access" for triage. **Hard enforcement (throw when
  no grant)** is intentionally deferred behind a future
  tenant-level `requireConsent: boolean` flag — flipping it
  on tenant-wide today would break every preauth submit on
  tenants that haven't backfilled grants yet. The roll-out
  plan: (1) wire consent capture into the intake screen, (2)
  backfill historical patients via the BT grant API, (3) flip
  the flag per tenant once the dashboard's "unbound" count is
  zero for that tenant.
- **Production cron wiring uses pg_cron, not k8s CronJob.**
  CC's choice was driven by "Redis is deferred"; pg_cron lives
  in the same Postgres instance the platform already needs,
  and the schedules are static (BP retention sweep nightly,
  BS breach scan every 15 min), so we don't need the k8s
  scheduler's flexibility. The migration installs the pg_cron
  extension + scheduled jobs idempotently. Future Sprint 10
  could revisit if we add per-tenant variable schedules.
- **Composite indexes match dashboard query shapes 1:1.** CD's
  index review identified four queries that did filtered counts
  via table-scans on the new tables (BS / BR / BT). Solution
  was four composite indexes on the exact `(tenantId, status,
  field)` / `(tenantId, occurredAt, action)` shapes the
  ComplianceDashboardService.load() method runs. The BU e2e
  tests now run an `EXPLAIN ANALYZE` snapshot on each query and
  fail CI if the plan regresses to a sequential scan. New
  dashboard queries that fall outside the indexed shape need a
  matching index slotted in here.
- **TPAs detect via name regex, not claim-ref prefix.**
  Mediassist and Paramount adjudicate on behalf of multiple
  underwriters; the EOB carries the underwriter's claim-ref but
  the TPA name appears in header / reason copy. Both the TS-side
  extractors and the Python detector handle this correctly via
  the `name_rx` fallback path. New TPA payers should follow this
  pattern (their claim-ref prefixes overlap with private rails,
  so detection has to lean on body text).

## Open questions for the user

1. **Hard consent enforcement rollout.** The threading shipped
   in CB; the tenant-level `requireConsent` flag and the intake
   capture flow are next. Worth doing in Sprint 10, or wait
   until first paying tenant has signed an agreement that lists
   the consent surface as a contractual deliverable?
2. **OCR v1 timing.** v0 stub ships responses for the sentinel
   patterns the integration tests use. v1 (PaddleOCR + Qwen2-VL
   or GOT-OCR2.0) is the 1.5–2.5-week build that produces real
   structured fields. Worth starting v1 inside Sprint 10
   alongside intake-flow consent capture, or defer until v0
   stub limitations bite (operators keying everything in by
   hand)?
3. **OVH KMS provisioning.** Open since Sprint 5. The
   wrap-format and adapter abstraction are ready; flipping the
   env variable + provisioning the OVH KMS instance is a
   one-deploy change. Worth doing pre-go-live, or defer until
   first paying tenant?
4. **Sandbox PMJAY participant for end-to-end runs.** Open
   since Sprint 7. The Sprint 7 onboarding CLI (BN) needs an
   OTP from a real PMJAY sandbox to provision a participant id
   + bearer token; until then the PMJAY adapter stays in stub
   mode.
5. **Lending v1 confirmation.** Open since Sprint 8. RBI 10y
   `financial` retention floor assumes DigiSparsh-lending is
   in v1. If lending slips, the floor collapses to IRDAI 5y
   and we save half the `audit_log` storage.

## Sprint 10 likely shape

Sprint 9 closes the audit-compliance + per-payer normalisation
axes; Sprint 10's natural scope is the v1 launch readiness work:

- **OCR v1** — PaddleOCR + Qwen2-VL/GOT-OCR2.0 in the existing
  Python repo. Per-payer prompt tuning for the top six. ~1.5–2.5
  weeks; runs in parallel with intake work below.
- **Intake-flow consent capture** — the missing piece that
  unblocks hard-enforcement rollout. Adds a consent step to the
  `/cases/new` intake screen that captures the patient's
  consent before any preauth / claim flow runs. ~3–4 days.
- **Hard consent enforcement rollout** — tenant-level
  `requireConsent` flag + per-tenant flip plan. ~2 days once
  intake is in place.
- **Production deploy work** — OVH KMS provisioning, OVH
  Postgres + region setup, k8s manifests, monitoring + alerting
  on the BU dashboard's "overdue breach" + "unbound access"
  signals. ~1 week.
- **Optional**: backfill historical consent records on
  development tenants if any data has accumulated.

After Sprint 10 the platform is feature-complete for v1 launch.
Time-to-production estimate from 2026-05-07 (~9 weeks) is now
~2 weeks remaining + the deferred infra work, on track.

## Repo state at exit

| Repo                     | Branch  | SHA       | Notes                                                |
| ------------------------ | ------- | --------- | ---------------------------------------------------- |
| `claims-platform`        | `main`  | `5cda4eb` | All Sprint 9 TS slices merged                        |
| `eob-ocr-machine`        | `main`  | `573f62b` | v0 stub + per-payer detection ported                 |

Both repos pass tsc / pyright equivalent + lint + unit suites at
exit. Integration suite on `claims-platform` runs cleanly against
Neon dev DB. OCR repo has no integration suite yet — v1's
PaddleOCR work will need GPU-backed CI (deferred).
