# NHCX integration — changes log after spec scrape

Context for Claude-in-VS-Code. This file enumerates every change made to the claims platform after the NHCX spec was scraped into `D:\NHCX context\` and the gap analysis was written. Use it to bring a fresh session up to speed.

**Inputs:**
- Spec corpus: `D:\NHCX context\CONTEXT_lean.md` (33 MB stitched markdown), 95 page sources under `D:\NHCX context\md\` (NRCES IG, ABDM PDFs, GitHub NHA-ABDM repos, HL7 R4, sandbox docs).
- Gap analysis: `D:\NHCX context\GAP_ANALYSIS.md` (1,100 lines, 17 areas, ~80 matrix rows, 10 pre-cutover blockers, 15 things-to-determine).

**Current test status:** 396 / 396 tests pass across 45 suites. `pnpm --filter @claims/api typecheck` clean. `pnpm --filter @claims/web typecheck` clean.

---

## Round 1 — FHIR bundle + adapter + onboarding (closes blockers #1–#5)

### Bundle shape — NRCES profiles + meta.security + SNOMED + line items
`apps/api/src/modules/nhcx/fhir-builders.ts`
- Replaced 5 `https://ig.hcxprotocol.io/v0.7.1/...` profile URLs with `https://nrces.in/ndhm/fhir/r4/StructureDefinition/...` (ClaimBundle, CoverageEligibilityRequestBundle, CommunicationBundle, TaskBundle).
- Added `meta.profile` to every contained resource (Patient, Organization, Coverage, Practitioner, Claim, Communication, Task, CoverageEligibilityRequest).
- Added `meta.security` `v3-Confidentiality / V — very restricted` to every PII-bearing bundle.
- Switched `Claim.type` from HL7 `institutional` → SNOMED `737481003` (Inpatient care management).
- Switched procedure default system to SNOMED CT; legacy `urn:digisparsh:procedure:code` still accepted via explicit override.
- Switched `Claim.diagnosis.type` to SNOMED `89100005` (Final diagnosis discharge); added optional `diagnosisSnomedCode` ride-along to `diagnosis.diagnosisCodeableConcept.coding[]`.
- System-coded `Claim.supportingInfo.category` against `ndhm-supportinginfo-category` (was bare code).
- Dropped `https://ig.hcxprotocol.io` from `Bundle.identifier.system` — now bare `{value}`.
- New types: `FhirPractitionerFields` + `practitionerResource()` → emitted as a Practitioner resource referenced by `Claim.careTeam[0]`.
- New types: `FhirClaimLineItem` + `Claim.item[]` projection with `productOrService` (defaults to `ndhm-billing-codes`), `unitPrice`, `net`, optional `servicedDate` / `quantity`.
- New optional inputs on `FhirPreauthSubmitInput` / `FhirClaimSubmitInput`: `admissionStart`/`admissionEnd` → `Claim.billablePeriod`, `coverageTypeCode` → NDHM-coded `Coverage.type`, `hbpPackageCode` → second procedure coding for PMJAY rail.
- Task bundles (cancel + reprocess) now dual-code: NDHM canonical (`ndhm-task-codes`) first, PMJAY-specific URI second.
- Added `'discovery'` to `FhirEligibilityPurpose` union.

### Validator — NDHM systems whitelist
`apps/api/src/modules/nhcx/fhir-validator/known-code-systems.ts`
- Added 18 missing NDHM CodeSystem URIs to `NHCX_SYSTEMS`: `ndhm-adjudication-reason`, `ndhm-benefit-type`, `ndhm-billing-codes`, `ndhm-claim-exclusion`, `ndhm-coverage-type`, `ndhm-form-code`, `ndhm-insuranceplan-type`, `ndhm-payment-type`, `ndhm-plan-type`, `ndhm-price-components`, `ndhm-program-code`, `ndhm-reason-code`, `ndhm-related-claim-relationship-code`, `ndhm-supportinginfo-category`, `ndhm-supportinginfo-code`, `ndhm-task-codes`, `ndhm-task-input-type-code`, `ndhm-task-output-type`, `ndhm-task-output-value`.
- Added SNOMED, LOINC, claim-care-team-role, v3-Confidentiality to `UNIVERSAL_SYSTEMS`.
- Exported `NDHM_SYSTEMS` map of named accessors.

### Adapter — 10 headers + URL routing + Cavage signing + per-tenant codes + chain context
`apps/api/src/modules/nhcx/nhcx-jwe.adapter.ts`
- Adds all 10 required `x-hcx-*` headers on every outbound call (was 3): `correlation-id`, `request-id` (distinct per HTTP request), `api-call-id` (chain root), `sender-code`, `recipient-code`, `timestamp`, `workflow-id` (`"1"`), `status` (`request.initiated`), `use-case` (`New`/`Enhancement`/`Cancel`/`Reprocess`/`Resubmission`), `ben-abha-id` (when ABHA present), `operation`.
- `OPERATION_PATHS` map resolves operation keys to canonical URL paths (`/api/<service>hcxservice/<service>/<action>`). All 11 doc-07 operations covered plus placeholders for predetermination, search, paymentnotice ack.
- `resolveSenderCode()` prefers per-tenant participant code over global env — multi-tenancy fix.
- New `OutboundContext` parameter: `inheritCorrelationId`, `rootCorrelationId`, `useCase`, `benAbhaId`, `recipientCode`.
- Every public method passes the receiverCode + relevant chain context through.

`apps/api/src/modules/nhcx/nhcx-adapter.interface.ts`
- `NhcxChainFields` mixin (`parentCorrelationId`, `useCase`) extended into every Adapter*Input shape.

### Contracts — onboarding step keys + descriptors
`packages/contracts/src/onboarding.schema.ts`
- Added 3 NHCX-axis step keys: `hfr_facility`, `nhcx_participant_code`, `nhcx_callback_url`.
- New `ONBOARDING_STEP_DESCRIPTORS` table: per-step `title`, `purpose`, `captures[]`, `externalAction`, `blocksNhcxCutover` flag. Single source of truth for the readiness UI.

### API readiness service
`apps/api/src/modules/onboarding/readiness.service.ts`
- `prettyKey` switch extended to cover the 3 new step keys (was a TS exhaustiveness failure).

### Web UI — admin/onboarding rewrite
`apps/web/app/(dashboard)/admin/onboarding/page.tsx`
- Replaced flat 8-row checklist with grouped layout (Hospital identity / NHCX participant onboarding / PMJAY / Master data / Governance).
- Top "NHCX sandbox cutover readiness" banner counts blockers (X of Y), turns green when all satisfied, lists specific blocking steps inline.
- Per-step expand/collapse: shows purpose, captures list, external-action link (e.g. facility.abdm.gov.in for HFR), completion timestamp, recorded evidence JSON.
- Readiness probes panel separated from the self-attested checklist.

---

## Round 2 — Prisma correlation-chain columns + 4 service wirings

### Schema
`apps/api/prisma/schema.prisma` — added 7 nullable text columns to `Claim`:
- `insuranceCorrelationId`, `coverageCorrelationId`, `preauthCorrelationId`, `enhancementCorrelationId`, `dischargeCorrelationId`, `claimCorrelationId`, `paymentCorrelationId`.
- Indexes on `preauthCorrelationId` + `claimCorrelationId` (hot callback-dispatch paths).

### Migration
`apps/api/prisma/migrations/20260531000000_claim_correlation_chain/migration.sql` — additive-only DDL.

### Service wirings — chain reads + writes
| Service | Reads as `parentCorrelationId` | Writes after adapter returns |
|---|---|---|
| `apps/api/src/modules/insurance-plan/insurance-plan.service.ts:request` | _(chain root)_ | `insuranceCorrelationId` |
| `apps/api/src/modules/eligibility/eligibility.service.ts:run` | _(top of chain)_ | `coverageCorrelationId` |
| `apps/api/src/modules/preauth/preauth.service.ts:submit` | `coverageCorrelationId ?? insuranceCorrelationId` | `preauthCorrelationId` |
| `apps/api/src/modules/preauth/preauth.service.ts:respondQuery` | `preauthCorrelationId` | `enhancementCorrelationId` |
| `apps/api/src/modules/discharge/discharge.service.ts:submit` | `enhancementCorrelationId ?? preauthCorrelationId` | `dischargeCorrelationId` |
| `apps/api/src/modules/claim-submit/claim-submit.service.ts:submit` | `dischargeCorrelationId ?? enhancementCorrelationId ?? preauthCorrelationId` | `claimCorrelationId` |
| `apps/api/src/modules/nhcx/inbound/nhcx-inbound.service.ts:paymentnotice/request` | _(inbound only)_ | `paymentCorrelationId` |

Each write happens inside the same tenant tx that records the outbound `IntegrationMessage` row → chain id and ledger row stay atomically consistent.

---

## Round 3 — Outbound Cavage HTTP Signature

### New module
`apps/api/src/modules/nhcx/outbound-http-signature.ts` — `signOutboundRequest()`. Same six signed headers the inbound verifier requires (`(request-target)`, `host`, `date`, `digest`, `x-hcx-correlation-id`, `x-hcx-operation`). Reuses `computeDigest` and `buildSigningString` from `inbound/http-signature.ts` to keep the two sides byte-for-byte symmetric.

### Adapter integration
`apps/api/src/modules/nhcx/nhcx-jwe.adapter.ts:callOperation`
- Computes Digest over the actual wire body (`bodyToSend`), not the raw JWE — necessary because the body may be envelope-wrapped.
- Stamps `date`, `digest`, `host`, `signature` headers.
- KeyId is `<participantCode>:<version>` (e.g. `digisparsh@hcx:v1`) so NHA can look up the right public key from the rotation set.
- `NHCX_SIGN_OUTBOUND=0` disables (rare sandbox cases that reject signed requests).

### Tests
`apps/api/src/modules/nhcx/outbound-http-signature.spec.ts` — 6 round-trip tests. Outbound signer's output is verified against the inbound verifier — if either side drifts, this fails.

---

## Round 4 — `insuranceplan/request` (gap row 1.13, chain root)

### FHIR builder
`apps/api/src/modules/nhcx/fhir-builders.ts`
- New `FhirInsurancePlanRequestInput` type.
- New `buildInsurancePlanRequestBundle()` matching NRCES `Bundle-TaskBundleForInsurancePlanRequest-example-01.json`: TaskBundle with Task carrying `financialtaskcode/poll` + two `input[]` entries (`policyNumber` + `providerId`) on `ndhm-task-input-type-code` + two Organization entries (requester + owner).
- New constant `SYS_FINANCIAL_TASK_CODE`.

### Adapter surface
`apps/api/src/modules/nhcx/nhcx-adapter.interface.ts` — `AdapterInsurancePlanRequestInput` + `AdapterInsurancePlanRequestResult`; `requestInsurancePlan` method added to `NhcxAdapter`.

`apps/api/src/modules/nhcx/nhcx-jwe.adapter.ts` — `requestInsurancePlan` calls `callOperation('insuranceplan/request', …)` with `useCase: 'New'` and no `inheritCorrelationId` (chain root).

`apps/api/src/modules/nhcx/nhcx-stub.adapter.ts` — stub returns a fake plan preview. Env `NHCX_STUB_INSURANCEPLAN_FAIL=<policy1,policy2>` flips to a "policy not recognised" outcome for those policy numbers.

`apps/api/src/config/env.schema.ts` — added `NHCX_STUB_INSURANCEPLAN_FAIL`.

### Service + module
`apps/api/src/modules/insurance-plan/insurance-plan.service.ts` (new) — `InsurancePlanService.request()`. Calls the adapter, stamps `claim.insuranceCorrelationId` (when claimId is passed), writes the outbound `IntegrationMessage` row, marks succeeded with the inbound row. All in one tenant tx.

`apps/api/src/modules/insurance-plan/insurance-plan.controller.ts` (new) — two endpoints:
- `POST /cases/:caseId/claims/:claimId/insurance-plan/lookup` (chain-stamping path)
- `POST /insurance-plan/lookup` (freestanding pre-admission path)

`apps/api/src/modules/insurance-plan/insurance-plan.module.ts` (new) + `index.ts` (new).

`apps/api/src/app.module.ts` — `InsurancePlanModule` registered.

### Contracts
`packages/contracts/src/integration.schema.ts` — `InsurancePlanRequestSchema` + `InsurancePlanRequestResponseSchema`.

### Tests
`apps/api/src/modules/nhcx/insurance-plan-builder.spec.ts` (new) — 5 builder-shape assertions.
`apps/api/src/modules/nhcx/nhcx-stub-insurance-plan.spec.ts` (new) — 4 stub behaviour tests.
`apps/api/src/modules/nhcx/fhir-builders.snapshot.spec.ts` — added insurance-plan-request snapshot fixture.
`reference/fhir-bundles/insurance-plan-request.json` (new fixture).

---

## Round 5 — Runtime flags for architectural decisions (rows 2.1, 2.10, 9.3)

The authoritative NHCX spec for header naming, wire-format envelope, and mTLS mandate couldn't be confirmed offline (`nhcx.abdm.gov.in/NHCX_Specifications/*` are SPA shells). Live-portal web fetches all 403/404/503. Made all three runtime-configurable so the decisions become a config flip at sandbox-test time.

### Env schema
`apps/api/src/config/env.schema.ts`
- `NHCX_HEADER_STYLE: 'hyphenated' | 'underscored'` (default hyphenated; matches inbound guard).
- `NHCX_WIRE_FORMAT: 'bare' | 'envelope' | 'envelope-omit-type-insurance-coverage'` (default `envelope-omit-type-insurance-coverage`; honours documented DigiNode quirk).
- `NHCX_MTLS_ENABLED: BooleanLike` (default false).
- `NHCX_MTLS_CLIENT_CERT_BASE64`, `NHCX_MTLS_CLIENT_KEY_BASE64`, `NHCX_MTLS_CA_BASE64`.

### Config loader
`apps/api/src/config/configuration.ts`
- `AppConfig` exposes resolved `nhcxMtlsClientCertPem`, `nhcxMtlsClientKeyPem`, `nhcxMtlsCaPem`.
- Boot-time check: `NHCX_MTLS_ENABLED=true` requires both cert + key (CA optional).

### Adapter
`apps/api/src/modules/nhcx/nhcx-jwe.adapter.ts`
- Wire-format selector builds either bare JWE string (`application/jose`) or JSON envelope `{"payload": "<jwe>", "type": "JWEPayload"}` (`application/json`). The `envelope-omit-type-insurance-coverage` variant drops `type` for insurance + coverage operations only.
- Response decoder accepts either: JSON-envelope-wrapped responses are unwrapped via the `.payload` field before JWE decrypt.
- Lazy mTLS `undici.Agent` dispatcher cached on the adapter instance; TLS connection pool reused across calls.
- `NHCX_HEADER_STYLE` read via `ConfigService` (was bare `process.env`).

### New dep
`apps/api/package.json` — `undici` added (for the mTLS dispatcher).

### Decision record
`docs/decisions/NHCX_INTEGRATION_FLAGS.md` (new) — explains each flag's options, default, evidence, symptoms that should trigger a flip, and the priority order to flip them in.

---

## Round 6 — `insuranceplan/on_request` enrichment loop (gap row 1.14)

### Parser
`apps/api/src/modules/nhcx/inbound/fhir-response-parsers.ts`
- `ParsedInsurancePlan` extended with `sumInsuredPaise`, `periodStart`, `periodEnd`, `network`.
- New `extractSumInsuredPaise()` helper handles 3 FHIR shapes payers use: `coverage[].benefit[].limit[].value`, `plan[].generalCost[].cost`, and `extension[]` with URL containing `sum-insured` (valueMoney / valueQuantity / valueDecimal). All values normalised to paise.

### Schema + migration
`apps/api/prisma/schema.prisma` — new `InsurancePlanLookup` model. Keyed by `correlationId` (unique). Optional `claimId` (freestanding lookups land somewhere too). Plan-detail columns nullable until callback. Status `pending` → `resolved` | `failed`.

`apps/api/prisma/migrations/20260601000000_insurance_plan_lookup/migration.sql` — table, indexes, RLS policies, claims_app grant. Same shape as `integration_message`.

### Service
`apps/api/src/modules/insurance-plan/insurance-plan.service.ts`
- `request()` now writes the pending `InsurancePlanLookup` row inside the same tx as the chain stamp + ledger write. Three-way atomic.
- `recordResponse()` — idempotent UPSERT-by-correlationId called by the inbound dispatcher; re-running on a terminal row is a no-op.
- `findByCorrelationId()` + `findLatestForClaim()` — read methods used by the controller.
- New types: `InsurancePlanLookupView`, `RecordInsurancePlanResponseInput`.

### Inbound dispatcher
`apps/api/src/modules/nhcx/inbound/nhcx-inbound.service.ts`
- Constructor takes `InsurancePlanService`.
- `insuranceplan/on_request` branch was log-and-drop; now calls `insurancePlan.recordResponse(...)` with parser output.
- Parser exceptions caught and recorded as `status: 'failed'` with the exception message in `failureReason` (visible on the same row instead of API logs).

`apps/api/src/modules/nhcx/inbound/nhcx-inbound.module.ts` — `InsurancePlanModule` added to imports.

### Read API
`apps/api/src/modules/insurance-plan/insurance-plan.controller.ts`
- `GET /cases/:caseId/claims/:claimId/insurance-plan` — latest lookup for a claim. 404 means "never asked"; 200 + `status: 'pending'` means "asked, waiting".
- `GET /insurance-plan/lookups/:correlationId` — direct read for freestanding lookups.

### Contracts
`packages/contracts/src/integration.schema.ts` — `InsurancePlanLookupSchema` + `InsurancePlanLookup` type. Status union is `'pending' | 'resolved' | 'failed'`.

### Tests
8 new parser tests covering the three sumInsured paths, period truncation, network display, and the negative path. All 396 / 396 tests pass.

---

## Open from `D:\NHCX context\GAP_ANALYSIS.md` (not yet implemented)

| Gap row | Item | Notes |
|---|---|---|
| 1.10 | Outbound `paymentnotice/on_request` ack | Only needed if NHA requires provider-side ack |
| 1.15 | `predetermination` use of Claim | Cost estimation pre-service; v2 |
| 3.15 | Proper `Composition`-based discharge bundle | Currently a free-text Communication payload — works but isn't the NRCES profile shape |
| 5.4 | KMS-wrapped private key storage | Sprint-10 production-deploy work |
| 8.5 | NHA-facing audit-export endpoint | Required by NHA if/when they publish the audit schema |

**Architectural decisions still pending** (made runtime-configurable in Round 5; flip when NHA gateway behaviour is observed):
- `NHCX_HEADER_STYLE` — hyphenated vs underscored
- `NHCX_WIRE_FORMAT` — bare vs envelope vs envelope-omit-type-insurance-coverage
- `NHCX_MTLS_ENABLED` — plain HTTPS + Cavage signing vs mTLS + Cavage signing

**UI follow-up not yet shipped:**
- Case-detail page doesn't yet read the new `InsurancePlanLookup` row to show plan preview card. Roughly one Next.js component change against `apps/web/app/(dashboard)/cases/[id]/page.tsx`.

---

## Quick file map for navigation

**Spec corpus + analysis (read-only context):**
- `D:\NHCX context\CONTEXT_lean.md`
- `D:\NHCX context\GAP_ANALYSIS.md`
- `D:\NHCX context\md\nrces.in\ndhm\fhir\r4\` — per-resource FHIR IG pages

**Platform changes — root:**
- `apps/api/src/modules/nhcx/` — adapter + crypto + key resolver + outbound signing + builders + validator
- `apps/api/src/modules/nhcx/inbound/` — webhook controller + dispatcher + parsers + signature guard
- `apps/api/src/modules/insurance-plan/` — chain-root service + controller (new in this work)
- `apps/api/src/modules/{eligibility,preauth,discharge,claim-submit}/` — chain-aware service wirings
- `apps/api/prisma/schema.prisma` — `Claim` correlation columns + `InsurancePlanLookup` model
- `apps/api/prisma/migrations/2026053{1,...}_*` — chain + lookup migrations
- `packages/contracts/src/{integration,onboarding}.schema.ts` — wire types
- `apps/web/app/(dashboard)/admin/onboarding/page.tsx` — rewritten checklist
- `docs/decisions/NHCX_INTEGRATION_FLAGS.md` — runtime-flag decision record

**Run before next session:**
```bash
pnpm install
pnpm --filter @claims/api exec prisma generate
pnpm --filter @claims/api typecheck
pnpm --filter @claims/web typecheck
pnpm --filter @claims/api test
```
