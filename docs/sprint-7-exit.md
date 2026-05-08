# Sprint 7 — Exit document

Sprint window: started after PR #64 (Sprint 6 exit doc) merged on
2026-05-07; this doc is written at the Sprint 7 paperwork pause on
2026-05-08 with PR #74 (Slice BN) on `main`.

## What shipped

Ten slices. Two halves:

1. **Operational hardening (BE).** `/health/ready/deep` extends the
   liveness/readiness contract with parallel ClamAV (zPING/PONG TCP)
   and EOB-OCR (HTTP HEAD) probes under a 2 s ceiling, so production
   load balancers can withhold traffic when a downstream adapter is
   sick rather than letting requests fan out and fail.
2. **PMJAY-via-NHCX (BF–BN).** The defining axis of this sprint.
   Mid-sprint discovery (recorded in the user-direction note on
   2026-05-07): PMJAY isn't migrating to a portal-automation flow
   we'd need to write per-state — it's migrating onto the **same
   HCX 0.7.1 protocol surface** we already implemented in Sprints
   1–6. That collapsed the previously-estimated 4–8 weeks of
   per-state YAML/Playwright work to ~8 protocol slices plus an
   onboarding CLI. Sprint 7 shipped the entire PMJAY axis on top of
   the existing HCX 0.7.1 stack.

| Slice | Theme                                                                                  | PR  |
| ----- | -------------------------------------------------------------------------------------- | --- |
| BE    | `/health/ready/deep` parallel ClamAV + EOB-OCR probes                                  | #65 |
| BF    | ABDM biometric auth adapter (off / stub / real factory)                                | #66 |
| BG    | PMJAY biometric gate on preauth + claim submit; `tenant.pmjayMode`; `biometric_verification` table | #67 |
| BH    | PMJAY preauth cancel via outbound `task/submit`; `PREAUTH_CANCELLED`; `buildTaskCancelBundle`     | #68 |
| BI    | PMJAY claim reprocess (CRC) via outbound `task/submit`; `CLAIM_REPROCESS_REQUESTED`               | #69 |
| BJ    | `POST /pmjay/policies/lookup` endpoint with stub adapter                               | #70 |
| BK    | PMJAY eligibility three-purpose dispatch (validation / benefits / auth-requirements)   | #71 |
| BL    | PMJAY drop Communication-based query response → resubmit endpoints instead             | #72 |
| BM    | FHIR code-system whitelist with PMJAY support; non-blocking inbound dispatcher warn    | #73 |
| BN    | PMJAY participant onboarding CLI (one-shot four-step flow)                             | #74 |

See `CHANGELOG.md` for per-slice detail. (Per-PR CHANGELOG
discipline held throughout — no backfill chore needed.)

## Test coverage at exit

| Suite (representative)                                  | Cases | Notes                                                     |
| ------------------------------------------------------- | ----- | --------------------------------------------------------- |
| `health.controller.spec` (BE additions)                 |  10   | TCP probe state machine + clean-FIN handling on Linux     |
| `disabled-biometric-auth.adapter.spec` + stub spec      |   8   | Slice BF — both adapters, fail-list, replay protection    |
| `http-biometric-auth.adapter.spec`                      |  12   | Slice BF — request shape, headers, error paths            |
| `biometric-auth-gate.e2e`                               |   5   | Slice BG — PMJAY gate on preauth + claim submit           |
| `preauth-cancel.e2e`                                    |   3   | Slice BH — PMJAY-only cancel + ledger pair                |
| `fhir-builders.spec` (BH/BI/BK additions)               |  14   | Task cancel + reprocess + eligibility purpose dispatch    |
| `claim-reprocess.e2e`                                   |   3   | Slice BI — reasonCode↔status alignment guards             |
| `pmjay-policies.e2e`                                    |   5   | Slice BJ — tenant gate + Zod identifier validation        |
| `eligibility-pmjay-purpose.e2e`                         |   6   | Slice BK — 3 purposes + missing-purpose 422 + legacy path |
| `claim.state-machine.spec` (BL additions)               |   3   | `preauth.resubmission_started` + `claim.resubmission_started` |
| `pmjay-resubmit-on-query.e2e`                           |   6   | Slice BL — resubmit + Communication-respond rejection     |
| `fhir-validator.spec`                                   |  10   | Slice BM — pure validator + summariseFindings             |
| `pmjay-onboard-{client,state,keys}.spec`                |  20   | Slice BN — CLI client + state file + keypair helpers      |
| **Sprint 7 additions**                                  | **~105** | On top of ~395 cases from Sprints 1–6                  |

Full suite at exit: **~46 spec files** integration; **~370 cases**
unit + ~45 cases integration added this sprint. CI integration runner
heap bumped to 4 GB after Slice BK pushed the sequential-suite
footprint past V8's 2 GB default during teardown.

## Decisions worth remembering

- **PMJAY-via-NHCX inverts the docs/07 framing.** PMJAY is on the
  same HCX 0.7.1 endpoints we already implemented; the only
  rail-specific surface is (1) the biometric gate ahead of preauth /
  claim, (2) the few `task/submit`-driven gestures (cancel,
  reprocess), (3) the PMJAY policy lookup endpoint, and (4) the
  three-purpose `coverageeligibility/check` dispatch. There is **no**
  per-state YAML flow runner; portal automation framing is obsolete.
  Source: `HIMS-PMJAY suppporting docs/PMJAY Hospital Migration to
  HMIS via NHCX.docx` and the FHIR_bundles_PMJAY_ext/ samples.
- **Tenant-mode is the rail switch.** `tenant.pmjayMode` (`'on' |
  'off'`) drives every PMJAY-only behaviour: biometric gate (BG),
  preauth cancel (BH), claim reprocess (BI), policy lookup (BJ),
  eligibility purpose required (BK), Communication-respond rejected
  + resubmit available (BL), and the validator's
  PMJAY-systems-on-non-PMJAY-tenant misroute warning (BM). The
  pattern is: every service that runs a PMJAY-specific gesture
  loads `tenant.pmjayMode` first and either rejects with a
  field-targeted 422 or runs the gesture. Future PMJAY work should
  follow this shape.
- **`tenant` table reads must run inside `runInTenantContext(id,
  'tenant', ...)`.** Caught on CI in BG: `TenantService.findById`
  ran without an RLS context, so the SELECT policy
  (`app.tenant_id = id` or platform_admin) returned null silently
  even though the row existed. The PMJAY gate then evaluated
  `tenant?.pmjayMode === 'on'` as `undefined === 'on'` = false and
  silently bypassed. Fix wraps the lookup in
  `runInTenantContext(id, 'tenant', ...)`. Lesson generalises:
  any new code reading the `tenant` table must set the GUC to the
  looked-up id first.
- **Resubmit, not respond (BL).** PMJAY's documented workflow on a
  payer query is: pull the preauth (or claim) back to drafting,
  fix what the payer asked about, and re-submit through the same
  endpoint we use for the original submit. We don't synthesise a
  Communication response to a query for PMJAY — the existing
  `respondToQuery` endpoint rejects PMJAY callers with a
  field-targeted 422 pointing at `/preauth/resubmit`
  or `/claim-submission/resubmit`. State-only flips on our side; the
  next submit is what reaches the gateway. This keeps a single
  outbound surface per phase rather than a phase-specific Communication
  bundle.
- **Eligibility three-purpose dispatch (BK).** PMJAY runs
  `coverageeligibility/check` three times per case — `validation`
  (post-registration / wallet check), `benefits` (before preauth),
  `auth-requirements` (before submission). The FHIR builder emits a
  single-element `purpose` array per call. Private-rail callers
  keep the legacy combined `['benefits','validation']` when no
  purpose is supplied (back-compat); PMJAY tenants must specify or
  the service rejects with 422.
- **Validator is non-blocking (BM).** The FHIR code-system
  whitelist runs on every inbound bundle and emits a structured
  warn line when it finds unknown systems, unknown identifier-type
  codes, or PMJAY systems on a non-PMJAY-mode tenant
  (likely-misrouted callback). It does **not** reject — the
  gateway evolves faster than our whitelist could, and a hard
  reject would hold up legitimate callbacks. Operational signal
  only in v1; reject-mode stays a future option.
- **Onboarding CLI is operator-driven, not infrastructure (BN).**
  PMJAY participant onboarding happens once per hospital and
  needs SMS OTPs in the middle, so it's a CLI run by an ops
  person, not an automated pipeline step. State file with mode
  0600 supports `--resume` across the 24h-TTL second OTP. Generates
  a 2048-bit RSA keypair locally and never transmits the private
  key. After the four-step flow, the operator must raise an NHA
  ticket to map PMJAY Hospital ID ↔ NHCX Participant ID — that
  manual go-live trigger is out of scope for the CLI.
- **Slice naming shifted at BN.** The original Sprint 8 plan
  reserved BN for the audit retention `retention_class` column.
  BN was used for the onboarding CLI, so audit slices are now
  **BO–BU** (BO retention_class column + migration; BP retention
  sweeper cron Postgres function; BQ erasure-on-request workflow;
  BR `data_access_event` ledger; BS breach detection + 72h DPDP
  notification; BT consent record schema + UI; BU compliance
  dashboard).

## Bugs caught during the sprint

- **Slice BE jest timeout on the abrupt-close TCP test.** `sock.destroy()`
  on the server triggers a clean FIN on Linux → client gets `'close'`,
  not `'error'`, and the probe hangs. Fix: added a `socket.once('close', ...)`
  listener that fails the probe if the connection ends before
  PONG. Lesson: cross-platform TCP teardown semantics differ; the
  probe must handle both error-eviction and clean-FIN as failures.
- **Slice BG `TenantService.findById` running without RLS context.**
  Caught on CI, not locally. See "Decisions worth remembering" above.
- **Slice BI duplicate `reasonCode` key in stub adapter spread.**
  Explicit `reasonCode: input.reasonCode` plus `...input` spread
  duplicated the key. tsc surfaced it; fix is removing the explicit
  key and keeping the spread.
- **Slice BJ JWE real-mode honestly deferred.** PMJAY supporting
  docs document the `participant/get/policies` endpoint at the
  protocol level but don't publish the upstream URL inside the
  JWE-wrapped flow. Rather than guess, the JWE adapter throws a
  clear "not yet implemented; upstream URL undocumented in §5.6"
  error. Stub adapter ships the full happy path so frontend +
  service work can proceed.
- **Slice BK heap OOM during integration-suite teardown.** All 47
  e2e suites passed sequentially under `--runInBand`; jest worker
  hit ~1.8 GB heap and OOM'd during the cleanup phase. Fix:
  bumped `--max-old-space-size` to 4 GB on the `test:integration`
  npm script. Headroom for several more sprints before the suite
  needs splitting.
- **Slice BL Communication-respond gate had to fire BEFORE the
  query-row lookup.** Initial implementation ran the
  `preauth_query` lookup first; PMJAY callers got an "already
  responded" or "not found" message, not the helpful "use resubmit
  instead" one. Fix: tenant gate runs first, query lookup second.

## Deferred to Sprint 8

| Item                                                                  | Why deferred                                                                                                |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Audit log retention (DPDP / IRDAI / RBI strictest-of-three)           | Spec'd as Sprint 8's main axis. ~7 slices (BO–BU) with the constraint that RBI 10y applies because DigiSparsh-lending is planned in v1. |
| Real OVH KMS for the PII + comms root key                             | Deferred to production rollout per user direction. Wrap-format + adapter abstraction already in place since Sprints 5–6. |
| BullMQ-on-Redis migration                                             | Same multi-replica readiness story as Sprint 6 deferral. User direction: plug in at production time.        |
| Python EOB-OCR inference service                                      | Separate Python repo; estimated 1.5–2.5 weeks for v1 (PaddleOCR + regex + Qwen2-VL / GOT-OCR2.0). Thin v0 in 3–4 days. User is owning this build. |
| BJ JWE real-mode for `/participant/get/policies`                      | Upstream URL undocumented in PMJAY supporting docs; will surface when NHA publishes the JWE-wrapped contract. |
| FHIR validator → reject-mode                                          | Slice BM ships warn-only. Reject-mode is a config flip + the operational signal needs a few weeks of warn-line data first. |
| EOB OCR auto-persist + per-payer extractor routing                    | Carried over from Sprint 6 deferral; not Sprint 7 axis.                                                     |
| Document checksum verification on finalize                            | S3 `ChecksumSHA256` available; reading at finalize would catch truncated uploads. Hardening item.            |
| Notification outbox viewer                                            | Operators still can't see whether SMS/email actually sent. Useful for deliverability debugging.             |
| `parseClaimResponse` extracts identifier (Slice AE follow-up)         | Synchronous claimRefNum stamping at QUEUED works; cosmetic refactor.                                        |
| Sprint-7 PMJAY scenario test cases (`NHCX-PMJAY-HMIS Test Cases.xlsx`) | Spec sheet exists; running the full scripted test cases against a sandbox tenant is sandbox-dependent, deferred until provisioning. |

## Operational artefacts

- **PMJAY-via-NHCX is feature-complete on the API side.** A
  PMJAY-mode tenant can run the full lifecycle end-to-end through
  our API: onboard via the BN CLI → eligibility three times with
  the right purposes (BK) → biometric verify before preauth (BG) →
  preauth submit / cancel (BH) / resubmit on query (BL) → claim
  submit / reprocess (BI) / resubmit on query (BL) → settlement →
  payment. All with `tenant.pmjayMode = 'on'` flipped and the
  existing HCX 0.7.1 protocol stack underneath.
- **Adapter pattern consistency.** Every PMJAY-only service gate
  follows the same shape: `tenant.findById` (in
  `runInTenantContext`) → `if (tenant?.pmjayMode !== 'on') throw
  ValidationFailedError({ tenant: ['... PMJAY-only ...'] })` →
  proceed. Five services (BG biometric, BH preauth cancel, BI claim
  reprocess, BJ policy lookup, BK eligibility, BL preauth + claim
  resubmit) follow this pattern verbatim. New PMJAY-only gestures
  should match.
- **FHIR bundle building consistency.** Every PMJAY outbound
  message uses a single `buildXBundle` function in
  `apps/api/src/modules/nhcx/fhir-builders.ts` with deterministic
  UUIDs (test injection) + locked `meta.profile` against the
  HCX 0.7.1 IG. New bundle types follow the same shape:
  `buildEligibilityRequestBundle`, `buildPreauthSubmitBundle`,
  `buildClaimSubmitBundle`, `buildCommunicationBundle`,
  `buildTaskCancelBundle` (BH), `buildTaskReprocessBundle` (BI).
- **State-machine is now the canonical rail-agnostic surface.**
  Sprint 7 added five new transitions: `preauth.cancelled` (BH from
  4 from-states), `claim.reprocess_requested` (BI),
  `preauth.resubmission_started` (BL), `claim.resubmission_started`
  (BL). All are rail-agnostic at the state-machine level; the
  PMJAY-only gating happens at the controller / service layer.
  The state-machine spec covers the new transitions + their refusal
  from non-applicable states.
- **CI integration suite has a soft ceiling.** 47 e2e suites under
  `--runInBand` hit ~1.8 GB heap before BK; we're now at 4 GB
  ceiling. Future sprints adding ~10 e2e suites will eventually
  need either parallelisation, suite splitting (per-domain CI
  jobs), or shared-app reuse (single-AppModule across many
  describe blocks). Track when the run starts approaching 10 minutes.

## Open questions for the user

1. **OVH KMS provisioning timing.** The wrap-format + adapter
   abstraction has been ready since Sprint 5. Flipping the env
   variable + provisioning the OVH KMS instance is a one-deploy
   change. Worth doing pre-go-live, or defer until first paying
   tenant?
2. **Sandbox tenant for PMJAY end-to-end test runs.** The PMJAY
   supporting docs include `NHCX-PMJAY-HMIS Test Cases.xlsx` with
   scripted scenarios. Running them requires a sandbox PMJAY
   participant id + bearer token. Worth running the BN onboarding
   CLI against the sandbox now to provision one?
3. **Sprint 8 axis.** Audit retention (BO–BU) is the spec'd
   default. Other candidates: real OVH KMS, BullMQ migration,
   doc checksum / notification outbox / per-payer EOB extractor
   work that's been on the deferred list since Sprint 6. Audit is
   most compliance-blocking for go-live; the others can slip.

## Sprint 8 likely shape

Spec'd direction is **audit retention (BO–BU, ~7 slices)**:

- BO — `retention_class` column + migration on the audit log
  surface; backfill existing rows.
- BP — Retention sweeper as a Postgres cron function (Redis is
  deferred per user direction, so we don't have a job queue).
- BQ — Erasure-on-request workflow + endpoint + consent check;
  honors the DPDP-style purpose-bound retention metadata.
- BR — Append-only `data_access_event` ledger + middleware that
  records every PII read.
- BS — Breach anomaly detection + 72-hour DPDP notification
  template.
- BT — Consent record schema + UI + binding to data-access events.
- BU — Compliance dashboard.

Constraint: **strictest-of-three (DPDP Act 2023 + DPDP Rules 2025
+ IRDAI + RBI)**. RBI 10y applies because DigiSparsh-lending is
planned in v1; if lending slips, the retention floor collapses to
IRDAI 5y + DPDP and BO/BP can be simpler. Worth checking with the
user at Sprint 8 kickoff before scoping BO.

Likely two-sprint axis (Sprint 8 = BO–BR core; Sprint 9 = BS–BU
polish + per-payer extractors + perf).
