# Sprint 3 — Exit document

Sprint window: started after PR #20 (Sprint 2 exit / Slice Q) merged in
mid-May 2026; closed at PR #28 (Slice Y) on 2026-05-06.

## What shipped

Eight slices on top of the Sprint 2 business-domain skeleton. Theme:
production hardening — every Sprint 2 stub picks up its production
sibling (KMS encryption, virus scanning, FHIR bundles, key rotation,
audit UI, real-S3 tests, per-tenant comms config) and the multi-tenant
surface gets the controls compliance asks for.

| Slice | Theme                                                        | PR  |
| ----- | ------------------------------------------------------------ | --- |
| R     | Encrypted patient PII (Aadhaar / ABHA / policy / mobile / email) | #21 |
| S     | Document virus-scan + lifecycle sweep                        | #22 |
| T     | Real FHIR R4 bundle builders (HCX 0.7.1 profile)             | #23 |
| U     | ABDM token cache + NHCX key rotation                         | #24 |
| V     | Audit viewer + streaming CSV export                          | #25 |
| W     | Real-MinIO S3 round-trip + finalize-failure tests            | #26 |
| X     | Per-tenant SMTP + SMS config                                 | #27 |
| Y     | FHIR builder snapshot lock                                   | #28 |

See `CHANGELOG.md` for per-slice detail.

## Test coverage at exit

| Suite (representative)                          | Cases | Notes                                            |
| ----------------------------------------------- | ----- | ------------------------------------------------ |
| `pii.crypto.spec` + `patient-pii.e2e`           | 12+4  | AES-GCM + HKDF round-trip + RLS canary           |
| `stub-scan.spec` + `disabled-scan.spec`         |   5   | EICAR detection + skipped behaviour              |
| `document-scan.e2e`                             |   3   | Clean / infected / lifecycle sweep               |
| `fhir-builders.spec`                            |  11   | Bundle shape + identifier systems + paise math   |
| `fhir-builders.snapshot.spec`                   |   4   | Deterministic-deps snapshot lock                 |
| `nhcx-jwe-adapter.e2e` (additions)              |   1   | Bundle propagation through encrypt/decrypt        |
| `token-cache.spec` + `nhcx-key-resolver.spec` + |       |                                                  |
| `nhcx.crypto.spec` (additions)                  | 5+4+3 | TTL cache + per-version key resolution           |
| `token-cache-rotation.e2e`                      |   2   | HPR refresh-on-401 + NHCX retired-key decrypt    |
| `audit-viewer.e2e`                              |   6   | List + filter + CSV stream + cross-tenant canary |
| `document-real-s3.e2e`                          |   2   | MinIO round-trip + finalize 404 path             |
| `tenant-comms-config.service.spec` +            |       |                                                  |
| `tenant-comms-config.e2e`                       | 6+5   | Env fallback + override + redaction + RBAC       |
| **Sprint 3 additions**                          | **~73** | On top of the existing ~150 cases from Sprint 1+2 |

The CI gate now runs MinIO + the FHIR snapshot tests in addition to
the Sprint 1 / 2 integration suites. Total integration suite at exit:
**26 spec files, 153 cases**.

## Decisions worth remembering

- **Production-only env-gate enforcement (Slice R)** — strict checks on
  required env vars (e.g. `PII_KMS_ROOT_KEY_BASE64`) only fire when
  `NODE_ENV=production`. Non-prod boots even without them, and fails
  lazily at first use. This is a hard rule for every future env-gated
  feature: REAL mode is opt-in, never default-strict. Tracked in the
  `feedback_env_gates` memory.
- **Lookup hashes co-located with ciphertext (Slice R)** — exact-match
  hashes (`aadhaarHash`, `mobileHash`) sit on the same RLS-bounded
  rows as the ciphertext. Equality lookups don't need a salt; an
  attacker who reaches the hash already reached the row.
- **`hasDocumentType` requires `scanStatus IN ('clean','skipped')`
  (Slice S)** — discharge / claim-submit checklist gates would
  otherwise let an `infected` row count toward the requirement. The
  default `'skipped'` covers both pre-Slice-S rows (RLS migration set
  default) and `VIRUS_SCAN_MODE=off` deployments.
- **Adapter call outside Postgres tx, ledger inside (Slice K, kept)**
  — repeated in every Sprint 2 / 3 adapter wiring. The pattern is now
  load-bearing; the FHIR builders in Slice T preserve it.
- **`@Optional() @Inject(NHCX_KEY_RESOLVER)` (Slice U)** — the JWE
  adapter resolves the active key via an injected resolver in
  production but falls back to the legacy single-key flow when no
  resolver is provided. This lets the test harness construct the
  adapter without standing up a global resolver. The pattern is
  reusable for any adapter that needs to keep a "no-DI fallback" path.
- **Streaming CSV via async generator + `res.write` (Slice V)** —
  `streamForExport` yields 500-row batches; the controller pipes them
  straight to the underlying Express response. 100k-row hard cap so
  memory stays bounded. Same pattern is the right shape for any
  future "large export" endpoint.
- **`NODE_OPTIONS=--experimental-vm-modules` for AWS SDK v3 under
  Jest (Slice W)** — the SDK's `middleware-retry` issues dynamic
  `import()` that Jest's default VM rejects. Setting the flag at the
  test runner entry point keeps test discipline intact and is a safe
  scoped change. Future tests that pull in dynamic-import-using deps
  inherit it.
- **Redacted summary, never raw secrets (Slice X)** — `GET
  /tenant/comms-config` returns `passwordSet: bool` rather than the
  password. The shape generalises to any future tenant-secret read
  endpoint; the editor UI uses the flag to drive a "leave unchanged
  vs. retype" UX.
- **Snapshot fixtures with deterministic factories + `UPDATE_FIXTURES`
  env (Slice Y)** — the FHIR builders gain optional `uuid` / `now`
  factory inputs (`FhirDeterminismDeps`); production callers omit
  them, snapshot tests pass deterministic factories. Setting
  `UPDATE_FIXTURES=1` regenerates and the diff lands in the PR for
  human review. Reusable harness for any future "lock the JSON wire
  shape" requirement.

## Bugs caught during the sprint

- **Slice R CI failure** — strict `PII_KMS_ROOT_KEY_BASE64` boot-check
  broke 18+ existing integration suites. Fixed by gating on
  `NODE_ENV === 'production'`. Drove the env-gates feedback rule.
- **Slice U token-cache test flake** — the safety margin floored
  effective TTL at 1s, so an "expires by step 2" assertion needed a
  real-time wait of ≥1100ms (not a second tick on a fake clock).
- **Slice W AWS SDK + Jest** — see decision above. `cross-env` added
  as a devDep for portable shell behaviour.
- **Slice W MinIO bucket-visibility race** — `CreateBucket` returns
  before bucket metadata fully settles. `HeadBucket` poll (5x /
  200ms) closed the race. Without the poll the first PUT could
  surface as a 404 that looked like a test bug.
- **Slice W stale `pnpm-lock.yaml` after merge** —
  `git fetch && git reset --hard origin/main` was the safe recovery;
  destructive but local-only.
- **Slice X SMTP_PORT type drift** — `ConfigService` surfaces
  `SMTP_PORT` as a raw env string under some boot orderings even
  though the schema parses it to a number. Fixed by coercing at the
  resolver boundary; the integration test caught it.

## Deferred to Sprint 4 / 5

| Item                                              | Why deferred                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Real OVH KMS for the PII root key                 | Slice R uses a static `PII_KMS_ROOT_KEY_BASE64`; KMS wrap lands in Sprint 5.          |
| Real ClamAV virus scanner                         | Slice S ships EICAR stub. Real INSTREAM in Sprint 5.                                  |
| Real TextGuru SMS HTTP                            | Slice X ships logging stub. Real provider in Sprint 5.                                |
| KMS-wrap of `commsConfig` secrets                 | Slice X stores SMTP password / SMS apiKey on the row. Sprint 5 hardening.             |
| FHIR enrichment for preauth / discharge / submit  | Slice T wired eligibility only — highest-impact NHCX call. Other phases follow.       |
| Sprint 3 OpenAPI spec generation + Swagger UI     | Was the original Slice Y plan. Replaced by snapshot-lock; OpenAPI lands separately.   |
| S3 lifecycle deletion of abandoned objects        | Slice S sweeps the DB row but not the bucket object. Sprint 5.                        |
| HCX inbound webhook handlers                      | Sprint 2 / 3 only ship outbound NHCX traffic. Inbound + signature validation is next. |
| PMJAY rail real adapter                           | All Sprint 2 / 3 adapters are NHCX. PMJAY is its own integration sprint.              |
| Backfill atomic Case + Patient creation           | Sprint 2 leftover; Slice R adds the Patient model but the original two-tx call site
                                                       in `CaseService.create` is still split. Wrap in a future cleanup slice.            |

## Operational artefacts

- `reference/fhir-bundles/` is now a committed contract surface — any
  unintended payload-shape regression fails CI with a readable diff.
- `IntegrationMessage` ledger continues to back every external call.
  Per-tenant comms config (Slice X) writes ledger rows for SMTP / SMS
  delivery just like the NHCX / ABDM adapters.
- `/health/ready` reports the bound adapter modes — Sprint 3's new
  modes (`PII_KMS_MODE`, `VIRUS_SCAN_MODE`) are surfaced too.
- Audit log viewer at `apps/web/.../admin/audit/page.tsx` + CSV
  export — first compliance-facing UI in the platform.
- Per-tenant comms editor at `apps/web/.../admin/comms-config/page.tsx`
  — first per-tenant secret editor that's KMS-ready (KMS-wrap is
  the Sprint 5 hardening item).

## Open questions for the user

1. Sprint 4 axis — three plausible directions: deeper NHCX (real
   sandbox onboarding + the deferred Slice T integration tests), claim
   lifecycle (settlement / EOB ingestion / appeal flow), or PMJAY rail
   wiring. The roadmap doesn't mandate one over the others.
2. OpenAPI / Swagger UI — moved out of Slice Y. Land it as a
   stand-alone Sprint 4 slice, or roll it into the first Sprint 5
   hardening pass?
3. `commsConfig` KMS-wrap timing — Sprint 5 was the plan. Does the
   compliance posture for go-live require it sooner?
4. `IntegrationMessage` retention — same question Sprint 2 left open;
   no decision yet.

## Sprint 4 likely shape

Not committed yet. Candidates pending the user's call on the axis:

- Deeper NHCX — inbound webhook handlers + signature validation;
  FHIR enrichment for preauth / discharge / claim-submit.
- Settlement maturity — appeal flow, EOB OCR ingestion, end-to-end
  reconciliation against payer remittance files.
- PMJAY adapter — separate integration surface from NHCX.
- Cross-cutting hardening — OpenAPI spec generation, KMS-wrap of
  tenant secrets, real ClamAV / TextGuru wiring.
