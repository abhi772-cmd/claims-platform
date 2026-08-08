# Production handover — OVH cutover

> **You're picking up the claims-platform to take it from a working dev/stub stack to a stable production deployment on OVH.** This doc tells you exactly what's already done, what's left, and the order to do it. Read it top-to-bottom once, then jump to §4 for the cutover checklist.
>
> **If you're a Claude Code session** picking this up: also read `CLAUDE.md` (the hard rules), `SMOKE_TEST.md` (local verification), and `SESSION_HANDOFF.md` (prior session context). Do not skip them — the hard rules in CLAUDE.md are not negotiable.

---

## 1. What this product is

DigiSparsh Claims Platform — a multi-tenant SaaS for Indian hospitals processing insurance claims via NHCX (private cashless / reimbursement) and PMJAY (Ayushman Bharat). Hospitals submit pre-auth, enhancement, discharge, and final-claim bundles to payers via the NHCX gateway; receive decisions, settlements, and queries back via webhook callbacks; reconcile payments against UTRs.

### Tech stack (don't replace any of this lightly — it's all interlocked)

| Layer | What |
|---|---|
| Backend | **TypeScript strict** + **NestJS 10.3** (`apps/api`) |
| Frontend | **Next.js 14** App Router (`apps/web`) |
| DB | **Postgres 16** via **Prisma** (single multi-tenant schema, RLS-FORCE'd) |
| Queue / cache | **Redis 7** (BullMQ for the integration retry worker) |
| Object storage | **OVH S3-compatible** in prod (adapter is S3-API generic — MinIO works for dev) |
| Encryption-at-rest | **OVH KMS** for tenant credential blobs; **HKDF-derived DEKs** for column-level PII |
| FHIR / NHCX | Custom builders + parsers; JWE via `jose` (RSA-OAEP-256 + A256GCM) |

### What's in the repo

```
claims-platform/
├── apps/
│   ├── api/                       # NestJS — all business logic + integrations
│   │   ├── prisma/schema.prisma   # 100+ models, RLS policies, audit ledger
│   │   ├── src/config/            # env.schema.ts (Zod) + configuration.ts (validation)
│   │   ├── src/modules/           # ~60 modules, one per domain
│   │   └── test/integration/      # E2E specs (real Postgres, real Redis, mocked HTTP)
│   └── web/                       # Next.js — operator console
├── packages/
│   ├── contracts/                 # Zod schemas shared by api ↔ web
│   ├── error-codes/               # Single source of truth for error code → modal copy
│   └── ui-tokens/                 # Design tokens (CSS variables + Tailwind config)
├── docs/                          # Authoritative product spec — START HERE
├── reference/                     # FHIR sample bundles + error-codes table + payer master
└── infra/docker-compose/          # Local dev stack (postgres + redis + mailhog)
```

### What "production-stable" means here

1. Every external integration runs in `real` mode against the actual upstream, not the stub.
2. PII is encrypted at rest via OVH KMS (not the in-process stub key).
3. Backups are wired (Postgres + audit-message archives).
4. Monitoring catches integration failures, RLS violations, and JWE crypto errors.
5. The cron jobs in `docs/infra/production-cron.md` are scheduled.
6. Smoke test (§3) walks end-to-end without any "TODO" or stub bypass surfacing.

---

## 2. Current state (as of this handover)

### ✅ Done — runs cleanly end-to-end in stub/dev mode

- **NHCX certification gauntlet (PR #130, merged)** — full HCX 0.7.1 wire envelope: session-token bearer + 401-driven refresh, 10-field `x-hcx-*` protected header duplicated into JWE protected header, `{ payload: <jwe> }` JSON body envelope + ProtocolResponse error discrimination, 202 inbound response with `{ timestamp, status, correlation_id }`, NRCeS profile URIs on all bundles, IST naive ISO timestamps (`+05:30`), 30 MB inbound body limit, processingID cache for PMJAY get/policies.
- **FHIR bundle correctness** — Patient identifiers (PMJAY beneficiary, JHN, PI, Aadhaar with NRCeS-canonical system URIs), Practitioner+HPIN resource referenced from Claim.careTeam, Organization NPI/NIIP/HFR identifiers, Coverage.policyHolder/period/type, Claim.type SNOMED 737481003, supportingInfo category split (DIA/HDS/CD/INF + POI/OTHER with attachment guards), EDT/ADDD/DTH mandatory date codes.
- **PMJAY semantics** — CE discovery purpose, typed Coverage.benefit + wallet usedMoney + Coverage.class[] + MAND-* docs parser, partial+queried branch, pipe-delimited audit-trail parser, Task cancel reason-code enum with `initimationNumber` typo preserved (intentional — PMJAY rejects the corrected spelling), PMJAY no-discharge skip, zero-copay invariant clamp.
- **Settlement + InsurancePlan parsers** — PaymentReconciliation (UTR + detail[] with payment/tds/penalty), paymentack outbound emitter, InsurancePlan full parser (32 specialties + STG refs + 24 Claim-Condition extensions + versionId).
- **Error vocabulary** — 30+ canonical mappings (PAYR-* / NHCX-* / HL7-* / ClaimError-* / PreauthError-*) with transient/permanent/operator-action classification + typo normaliser.
- **Biometric polish** — X-Auth Token threaded into Claim.extension, registration + OTP types on the adapter interface, 30 min / 15 day / 5 min TTL config envs.
- **Audit-pass-2 silent failures closed (PR #131)** — storage stub-mode Proxy (no more null-cast NPE), cross-tenant sweep paths properly scoped to `runInTenantContext(SENTINEL_UUID, 'platform_admin', ...)`, narrowed transition catch in settlement (no longer swallows ValidationFailedError).
- **UI loading states (PR #132)** — unified `LoadingShimmer` component, sentence-case headings, `aria-current="page"` on the active sidebar item.
- **575 unit tests + 319 integration tests passing** (CI on main is green).

### ⚠️ Stubbed — works for dev but NOT production-grade

Each row's `_MODE` env flips `stub` → `real`. The `real` code path exists for some; for others it's documented as deferred. **The Config loader (`apps/api/src/config/configuration.ts`) refuses to boot if a real-mode env is missing — read it before you flip anything.**

| Adapter | Stub | Real (production target) | Status |
|---|---|---|---|
| `STORAGE_MODE` | `StubStorageAdapter` synthesises refs | `S3StorageAdapter` against **OVH Object Storage** | Real code exists. Needs OVH credentials. |
| `PII_KMS_MODE` | HKDF from `PII_KMS_ROOT_KEY_BASE64` | OVH KMS-wrapped DEKs | ⚠️ **`real` mode NOT implemented**. Config loader rejects `PII_KMS_MODE=real`. Build it as part of OVH cutover. |
| `VIRUS_SCAN_MODE` | `off` skips scanning entirely | ClamAV INSTREAM | Real code exists. Needs ClamAV endpoint. |
| `EOB_OCR_MODE` | `off` always returns `skipped` | PaddleOCR + Qwen2-VL inference service | Skeleton only — defer until after go-live. |
| `NHCX_MODE` | `NhcxStubAdapter` env-driven outcomes | `NhcxJweAdapter` against real NHA gateway | Real code exists. **Blocked on NHA sandbox / prod creds.** |
| `BIOMETRIC_AUTH_MODE` | `off` returns disabled | `HttpBiometricAuthAdapter` → ABDM | Real code exists for init/verify/refresh. **Register / OTP not yet implemented in real mode.** |
| `HPR_MODE` | `HprStubAdapter` allowlist + fixed OTP | `HprRealAdapter` → ABDM HPR registry | Real code exists. Needs ABDM creds. |

### 🚧 Deferred — work items still open after this session

| ID | Title | Effort | Blocked on |
|---|---|---|---|
| P3.25 | Weekly InsurancePlan refresh worker | medium | Cron infra + scheduling (see §5) |
| P3.26 | STG QuestionnaireResponse capture UI | medium | UI design decision |
| P5.30 | Biometric register + OTP real-mode HTTP | small | ABDM sandbox creds |
| — | 3 NHCX runtime flag decisions (`NHCX_HEADER_STYLE`, `NHCX_WIRE_FORMAT`, `NHCX_MTLS_*`) | depends | Observation of live NHA sandbox |
| — | OVH KMS provisioning + real-mode `PII_KMS_MODE` adapter | medium | This handover — that's you |
| — | k8s deploy manifests + monitoring + alerting | large | This handover — that's you |
| — | Real-EOB confidence tuning | medium | Post-go-live, real EOBs needed |

---

## 3. Smoke test (run this before AND after any production change)

Walk **`SMOKE_TEST.md`** at the repo root, top to bottom. It covers boot, login, the three main operator screens (cases / remittance / variance), the backend signals (seed, migration, queue rows), and known-issue triage.

**Critical pre-flight** (per the smoke doc — easy to forget):
```bash
git checkout main && git pull
pnpm install
pnpm --filter @claims/api exec prisma generate
pnpm --filter @claims/api db:migrate:deploy
pnpm --filter @claims/api db:seed     # ⚠️ communication permissions land here
pnpm -r typecheck && pnpm -r lint
```

Note: `SMOKE_TEST.md` §5 item #1 (Communications panel queued-pip) is **already shipped** in PR #109 — the doc is stale. Items 2–7 still apply.

---

## 4. Production cutover — concrete steps

Order matters. Each step assumes the prior one is done.

### 4.1 Provision OVH infrastructure (you, on day 1)

| Resource | Why | OVH product / setup |
|---|---|---|
| **Managed Postgres 16** (prod + replica) | Primary data store | Public Cloud Databases — Postgres, B2 tier minimum, with read replica for backups + analytics |
| **Managed Redis 7** | BullMQ queues + session cache | Public Cloud Databases — Redis |
| **Object Storage** (S3-compatible) | EOB uploads, FHIR Bundle archives, audit-trail exports | Object Storage Standard — create one bucket per env (`claims-prod`, `claims-staging`). Enable versioning + lifecycle (transition to Cold after 90d, delete after 7y per DPDP retention). |
| **OVH KMS (Sovereign Cloud)** | Tenant credential encryption + per-tenant DEK wrapping | OVH KMS — create one master key per environment. **Note:** real-mode adapter is not yet built (see §4.4). |
| **Public Cloud Instance** or **Managed Kubernetes** (MKS) | Compute for api + web | Two-node MKS cluster minimum (one node fails → service stays up). 4 vCPU / 8 GB per node is plenty for v1 traffic. |
| **Load Balancer** | TLS termination + path-based routing | OVH Public Cloud Load Balancer with Let's Encrypt cert |
| **Object Storage** (separate bucket) | Postgres logical backups (pg_dump nightly) | Separate bucket from the app one — different access policy |
| **Sovereign Cloud region** | DPDP § 16(1) data-localisation requirement | Pick `GRA` or `SBG` only; **don't pick `BHS` (Canada) or `WAW` if the tenant base is India-only**. India-localisation rule is currently legal-team's call — confirm before provisioning. |

### 4.2 Mint secrets

```bash
# JWT signing keys (RS256). Run once per environment.
ssh-keygen -t rsa -b 4096 -m PKCS8 -f jwt-private.pem -N ''
openssl rsa -in jwt-private.pem -pubout -out jwt-public.pem
base64 -w 0 jwt-private.pem > JWT_PRIVATE_KEY_BASE64.txt
base64 -w 0 jwt-public.pem  > JWT_PUBLIC_KEY_BASE64.txt

# NHCX participant keys (separate keypair). Same shape.
ssh-keygen -t rsa -b 2048 -m PKCS8 -f nhcx-private.pem -N ''
openssl rsa -in nhcx-private.pem -pubout -out nhcx-public.pem
# nhcx-public.pem is what you submit to NHA at participant onboarding.
# Their public key (you encrypt outbound JWE to) comes back from NHA.

# PII KMS stub root key (transitional until real KMS lands in §4.4).
openssl rand 32 | base64 -w 0  # → PII_KMS_ROOT_KEY_BASE64
```

**Store every secret in OVH Vault / kubernetes Secret. Never commit. Rotate the JWT keys every 90 days; PII root key only when compromised.**

### 4.3 Configure the production env

Start from `apps/api/.env.example`. Variables to set per environment, grouped by adapter:

**Core**
```
NODE_ENV=production
MODE=api                      # 'worker' for the BullMQ worker pod
DATABASE_URL=postgresql://claims_app:<pwd>@<ovh-pg-host>:5432/claims?schema=public&sslmode=require
DATABASE_URL_MIGRATOR=postgresql://claims_migrator:<pwd>@<ovh-pg-host>:5432/claims?schema=public&sslmode=require
REDIS_URL=rediss://<ovh-redis-host>:6379    # rediss:// for TLS
LOG_LEVEL=info
CORS_ORIGIN=https://app.digisparsh.in
WEB_BASE_URL=https://app.digisparsh.in
COOKIE_DOMAIN=digisparsh.in
COOKIE_SECURE=true
COOKIE_SAMESITE=lax
```

**JWT** (from §4.2)
```
JWT_PRIVATE_KEY_BASE64=<base64-encoded PEM>
JWT_PUBLIC_KEY_BASE64=<base64-encoded PEM>
JWT_ISSUER=claims-platform
JWT_AUDIENCE=claims-platform-web
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d
```

**Storage (OVH Object Storage)**
```
STORAGE_MODE=real
OVH_S3_ENDPOINT=https://s3.gra.io.cloud.ovh.net   # match your region
OVH_S3_REGION=gra
OVH_S3_BUCKET=claims-prod
OVH_S3_ACCESS_KEY=<from OVH>
OVH_S3_SECRET_KEY=<from OVH>
S3_FORCE_PATH_STYLE=true
S3_PRESIGN_TTL_SECONDS=900
S3_MAX_UPLOAD_BYTES=52428800
```

**Virus scan** (deploy ClamAV as a sidecar or DaemonSet)
```
VIRUS_SCAN_MODE=real
VIRUS_SCAN_ENDPOINT=clamav.claims-system.svc.cluster.local:3310
```

**PII KMS** — **transitional setting until §4.4 lands the OVH KMS adapter**
```
PII_KMS_MODE=stub
PII_KMS_ROOT_KEY_BASE64=<from §4.2>
PII_KMS_KEY_VERSION=v1
```
The Config loader allows `stub` in production only if `PII_KMS_ROOT_KEY_BASE64` is set. Don't flip to `real` until §4.4 ships.

**NHCX** — fill these in once NHA returns your participant code + public key
```
NHCX_MODE=real
NHCX_GATEWAY_URL=https://apisbx.abdm.gov.in/hcx   # sandbox first; prod URL when ready
NHCX_PARTICIPANT_CODE=<assigned by NHA>
NHCX_PRIVATE_KEY_BASE64=<from §4.2 (nhcx-private.pem, base64)>
NHCX_PRIVATE_KEY_VERSION=v1
NHCX_GATEWAY_PUBLIC_KEY_BASE64=<from NHA, base64>
NHCX_SESSION_TOKEN_URL=https://apisbx.abdm.gov.in/hcx/session
NHCX_CLIENT_ID=<from NHA>
NHCX_CLIENT_SECRET=<from NHA>
NHCX_HTTP_TIMEOUT_MS=15000
NHCX_INBOUND_VERIFY_SIGNATURE=true                # MUST be true in production
NHCX_INBOUND_SIGNATURE_MAX_SKEW_SECONDS=300
NHCX_INBOUND_RATE_LIMIT_PER_MINUTE=60
```

**ABDM HPR** (doctor verification)
```
HPR_MODE=real
ABDM_BASE_URL=https://apisbx.abdm.gov.in
ABDM_CLIENT_ID=<from ABDM>
ABDM_CLIENT_SECRET=<from ABDM>
ABDM_HTTP_TIMEOUT_MS=15000
```

**Biometric** (only required for PMJAY tenants)
```
BIOMETRIC_AUTH_MODE=real
BIOMETRIC_AUTH_BASE_URL=https://apisbx.abdm.gov.in
BIOMETRIC_AUTH_HTTP_TIMEOUT_MS=15000
BIOMETRIC_VERIFICATION_TTL_MINUTES=60
BIOMETRIC_REGISTRATION_TTL_MINUTES=30
BIOMETRIC_REFRESH_TTL_DAYS=15
BIOMETRIC_OTP_TTL_MINUTES=5
```

**SMTP** (TextGuru or any SMTP relay)
```
SMTP_HOST=<provider>
SMTP_PORT=587
SMTP_FROM=no-reply@digisparsh.in
TEXTGURU_BASE_URL=<provider URL if used>
```

**Swagger** — off in production
```
SWAGGER_ENABLED=false
```

### 4.4 Build the OVH KMS real-mode adapter (the one code-side gap)

The `PII_KMS_MODE=real` path is rejected by the config loader because the adapter doesn't exist yet. To implement:

1. **Find the stub:** `apps/api/src/modules/pii-encryption/` (look for `pii-kms-stub.adapter.ts` and `pii-kms.module.ts`).
2. **Implement `OvhKmsAdapter`** with the same interface as the stub. OVH KMS exposes an AWS-KMS-compatible API:
   - `Encrypt` → wraps a fresh DEK with the master key, returns ciphertext blob.
   - `Decrypt` → unwraps the blob, returns the DEK.
   - Use `@aws-sdk/client-kms` configured against the OVH endpoint (works because OVH KMS is AWS-KMS-API-compatible).
3. **Update `configuration.ts`** to allow `PII_KMS_MODE=real` when `OVH_KMS_*` envs are present (currently throws `'real mode (OVH KMS) is not implemented yet — use stub'`).
4. **Wire `OvhKmsAdapter` into `pii-kms.module.ts`** behind the mode flag.
5. **Migrate existing rows**: write a one-shot script that decrypts every PII column under the stub key, re-encrypts under the new wrapped DEK, and rewrites the row. Run it once during a maintenance window. **Test on staging first.**
6. **Rotate `PII_KMS_KEY_VERSION` to v2** on cutover so old rows (still stamped v1) can be identified and re-encrypted in the background sweeper.

**Acceptance:** integration suite passes with `PII_KMS_MODE=real`, and patient PII roundtrips through encrypt → decrypt → reads back identical.

### 4.5 Deploy

1. Build images: `pnpm --filter @claims/api build && pnpm --filter @claims/web build`. Containerise both (Node 20-alpine base). Push to OVH Private Registry.
2. **k8s manifests** — none exist yet. Write:
   - `Deployment` for `apps/api` with `MODE=api`
   - `Deployment` for `apps/api` with `MODE=worker` (for BullMQ — same image, different env)
   - `Deployment` for `apps/web` (Next.js standalone build)
   - `Service` + `Ingress` per deployment, TLS via cert-manager + Let's Encrypt
   - `Secret` for every env block in §4.3 (use sealed-secrets or external-secrets-operator pointing at OVH Vault)
   - `HorizontalPodAutoscaler` on api (CPU > 70%) and web (RPS > 50) — both pods are stateless so HPA scales clean
   - `NetworkPolicy` locking api → only Postgres + Redis + OVH S3 + ABDM/NHA outbound
3. **Cron jobs** — see `docs/infra/production-cron.md`. Either:
   - **pg_cron** for the audit-retention sweep (pure SQL, runs nightly 02:30 IST)
   - **k8s CronJob** for the breach detector scan (every 15 min, calls `pnpm --filter @claims/api breach:scan`)
4. **First-boot migration**: run the migrator job before bringing api up:
   ```bash
   kubectl create job claims-migrate --image=<your-api-image>:<tag> -- pnpm --filter @claims/api db:migrate:deploy
   kubectl wait --for=condition=complete job/claims-migrate
   ```
5. **Seed master data** once: `pnpm --filter @claims/api db:seed && pnpm --filter @claims/api db:seed:master`. Demo data only in non-prod.

### 4.6 Monitoring + alerting (currently NONE — set this up)

Minimum viable observability:

| Signal | Source | Tool | Alert rule |
|---|---|---|---|
| **API liveness** | `GET /health` (already exists) | OVH Load Balancer health check | 3 consecutive failures → page oncall |
| **NHCX outbound errors** | `integration_message.outcome = 'failed'` row count, last 5 min | Postgres metric → Grafana | `> 5/min` of permanent errors → page; transient errors → warn |
| **JWE crypto failures** | `failureClass = 'crypto'` in `integration_message` | Same as above | Any non-zero rate → page (indicates key mismatch with NHA) |
| **RLS denials** | Pino log search for `"row-level security"` | Loki / OVH Logs Data Platform | Any occurrence → page (indicates app-level RLS bypass attempt) |
| **Breach detector incidents** | `breach_incident` table, `status = 'detected'` | Postgres → Grafana | Any new row → notify DPO via Slack + email within 5 min |
| **Audit retention sweep** | pg_cron job result | pg_cron logs → Loki | Failure two nights in a row → page |
| **Worker queue depth** | Redis BullMQ `failed` + `delayed` counts | BullBoard or custom metric | `> 100` in failed → page |
| **Postgres** | OVH-managed metrics | OVH dashboard | Connection saturation > 80%, replication lag > 60s, disk > 80% |

**Pino is already configured** — logs land as structured JSON with `tenantId`, `correlationId`, `userId`. Pipe stdout to Loki / OVH Logs and you have queryable trails for free.

### 4.7 Backups + DR

| What | Frequency | Where | Retention |
|---|---|---|---|
| Postgres logical (`pg_dump`) | Nightly 03:00 IST | Separate S3 bucket | 30 days hot, 365 days cold |
| Postgres WAL (point-in-time) | Continuous | OVH-managed | 7 days |
| Object Storage (uploads) | OVH-managed versioning | Same bucket | 7 years (DPDP § 16(3)) |
| Audit ledger exports | Weekly | Separate WORM bucket | 7 years |

**Test the restore.** Quarterly: spin up a staging Postgres, restore the latest pg_dump, run smoke test against it. Untested backups are not backups.

---

## 5. Open items — what's queued after the OVH cutover

Sort these into the next sprint plan once production is humming:

1. **P3.25 weekly InsurancePlan refresh worker** — cron-style job that polls NHCX for InsurancePlan updates per tenant, writes new versions, marks old ones retired. Parser exists (`parseInsurancePlanFull` in `apps/api/src/modules/nhcx/inbound/fhir-response-parsers.ts`) with `versionId` already exposed; just needs the worker + scheduling.
2. **P3.26 STG QuestionnaireResponse capture UI** — the parser captures STG references on InsurancePlan, but the operator can't yet submit a STG QuestionnaireResponse from the case detail page. Needs a panel + API.
3. **P5.30 biometric register + OTP real-mode HTTP** — types are on the adapter interface; ABDM HTTP wiring for the 4 methods (`register`, `otpInitiate`, `otpVerify`) is the gap.
4. **NHCX runtime flag decisions** — `docs/decisions/NHCX_INTEGRATION_FLAGS.md` (will exist after sandbox observation). 3 flags blocked until you watch live NHA traffic:
   - `NHCX_HEADER_STYLE` — confirm `x-hcx-*` field naming the prod gateway accepts (underscore vs dash).
   - `NHCX_WIRE_FORMAT` — confirm whether the prod gateway expects the `{ payload: <jwe> }` JSON envelope or raw JWE body.
   - `NHCX_MTLS_*` — whether NHA requires mTLS in addition to bearer + JWE.
5. **Real-EOB confidence tuning** — `EOB_OCR_MODE=real` requires a PaddleOCR + Qwen2-VL inference service. Defer until 50+ real EOBs have flowed through to tune confidence thresholds.

---

## 6. Project docs to read (in this order)

1. **`CLAUDE.md`** (repo root) — the hard rules. TS strict, RLS context, claim_event on every transition, structured error codes, no PII in logs, no secrets in code. Breaking any of these breaks the product.
2. **`docs/01-overview-and-decisions.md`** — every architectural decision and why.
3. **`docs/02-architecture-and-stack.md`** — how the pieces fit.
4. **`docs/03-data-model.md`** — Prisma schema walkthrough.
5. **`docs/04-state-machines.md`** — claim status transitions. Don't add a status without updating this.
6. **`docs/07-nhcx-and-pmjay.md`** — NHCX/PMJAY integration spec.
7. **`docs/08-compliance-and-security.md`** — DPDP / IRDAI / RBI requirements.
8. **`docs/14-onboarding-and-auth.md`** — hospital onboarding, RBAC, MFA, doctor flow.
9. **`docs/infra/production-cron.md`** — cron job setup.
10. **`docs/runbooks/`** — operational playbooks (locked accounts, MFA recovery, IP self-lockout).
11. **`reference/error-codes.md`** — canonical error code → modal copy table.
12. **`SMOKE_TEST.md`** — end-to-end verification walk. Run after every deploy.
13. **`CHANGELOG.md`** — what each PR shipped (per-PR discipline is enforced).

---

## 7. Branch / PR conventions

- `feat/<module>-<short-name>`, `fix/<module>-<short-name>`, `chore/<short-name>` — one feature, one branch, one PR.
- Conventional commits: `feat(claim): ...`, `fix(preauth): ...`.
- Every PR updates `CHANGELOG.md` with a one-line entry under the active sprint header.
- Every state-machine change updates `docs/04-state-machines.md`.
- Every new error code adds a row to `reference/error-codes.md`.
- CI is the gate: lint + typecheck + unit + integration must all pass before merge. Squash-merge to main.

---

## 8. Quick reference — common commands

```bash
# Local dev
pnpm infra:up                                       # docker-compose: pg + redis + mailhog
pnpm --filter @claims/api dev                        # api on :3001
pnpm --filter @claims/web dev                        # web on :3000

# Test
pnpm -r typecheck && pnpm -r lint
pnpm --filter @claims/api test                       # unit
pnpm --filter @claims/api test:integration           # full e2e (needs pg + redis)

# DB
pnpm --filter @claims/api db:migrate                 # dev migrations
pnpm --filter @claims/api db:migrate:deploy          # production migrations
pnpm --filter @claims/api db:seed                    # base seed (permissions etc.)
pnpm --filter @claims/api db:seed:master             # master data (payer + package master)
pnpm --filter @claims/api db:seed:demo               # demo cases (NEVER in prod)
pnpm --filter @claims/api db:reset                   # nuclear, dev only

# Operational scripts
pnpm --filter @claims/api audit:retention-sweep      # one-off retention sweep
pnpm --filter @claims/api breach:scan                # one-off breach detection
pnpm --filter @claims/api pmjay:onboard              # PMJAY participant onboarding helper
```

---

## 9. Who-knows-what

- **Anything in `apps/api/src/modules/nhcx/`** — that's the entire NHCX wire layer. JWE adapter, FHIR builders, response parsers, error mapper, session-token service, processing-ID cache. Read `apps/api/src/modules/nhcx/nhcx-protocol.ts` first — it's the envelope spec.
- **Anything in `apps/api/src/modules/biometric-auth/`** — ABDM biometric integration. PMJAY-only.
- **Anything in `apps/api/src/modules/storage/`** — S3 + Stub adapters. Includes the fail-fast Proxy from PR #131 (don't accidentally inject `S3StorageAdapter` directly in stub mode — use `STORAGE_ADAPTER` token).
- **`apps/api/src/config/configuration.ts`** — boot-time validation. If your prod deploy crashes with `ConfigError`, this is where to read.
- **`packages/contracts/src/`** — Zod schemas shared api↔web. Change here, both sides see the new type.

---

## 10. When in doubt

1. Re-read `CLAUDE.md` § "Hard rules". Most "should I do X?" questions have an answer there.
2. The state machine (`docs/04-state-machines.md`) is the contract. Don't bypass `ClaimEventService.record`.
3. Every external call goes into `integration_message`. If it isn't logged, it's a bug.
4. RLS is enforced at the database. If a query returns rows it shouldn't, the tenant context wasn't set — find the missing `runInTenantContext`.
5. Run `SMOKE_TEST.md` after any change that touches more than one module.

Good luck. Ping the prior session's notes (`SESSION_HANDOFF.md`) for what shipped this sprint.
