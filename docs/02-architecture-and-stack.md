# 02 — System Architecture and Stack

This doc describes how the system is laid out and how requests flow through it. Read it once end-to-end before writing your first line of code.

---

## Architectural shape

**Modular monolith with extracted workers and an integration gateway.** One main API service (NestJS) holds all domain modules. Worker processes (separate containers, same codebase) handle async work. The integration gateway is a module-level boundary inside the API for now; a future extraction point.

This is deliberately not microservices. Microservices for v1 means distributed transactions across the claim aggregate, more deployments, more on-call surface, and more inter-service contracts that drift. We start consolidated and extract only when scale forces it.

```
                       ┌────────────────────────────────────┐
                       │  Hospital users (insurance desk,    │
                       │  billing manager, doctor, PMAM, CFO)│
                       └──────────────┬──────────────────────┘
                                      │ HTTPS
                                      ▼
                       ┌────────────────────────────────────┐
                       │            Nginx                    │
                       │   (shared with DigiSparsh, OVH)     │
                       └──────────────┬──────────────────────┘
                                      │
                ┌─────────────────────┼─────────────────────┐
                ▼                     ▼                     ▼
       ┌────────────────┐    ┌────────────────┐    ┌────────────────┐
       │  Next.js web   │    │   NestJS API   │    │ Callback shim  │
       │  (App Router)  │    │  (modular      │    │ (legacy URL    │
       │   SSR + RSC    │    │   monolith)    │    │  forwarder)    │
       └────────────────┘    └───────┬────────┘    └───────┬────────┘
                                     │                     │
                ┌────────────────────┼─────────────────────┘
                ▼                    ▼
       ┌────────────────┐   ┌────────────────┐    ┌────────────────────┐
       │  PostgreSQL 16 │   │  pg-boss queue │    │  External systems  │
       │  + RLS         │◀──┤  (Postgres)    │    │  - NHCX gateway    │
       │  + pgaudit     │   └───────┬────────┘    │  - PMJAY TMS       │
       │  + pgcrypto    │           │             │  - ABDM (ABHA/HFR) │
       │  + pg_partman  │           ▼             │  - TextGuru SMS    │
       └────────┬───────┘   ┌────────────────┐    │  - SMTP (Nodemailer)│
                │           │  Workers        │    │  - OpenAI API      │
                │           │  (NestJS in    │◀───┤  - OVH KMS         │
                │           │   worker mode) │    │  - OVH Object Store│
                │           └────────────────┘    └────────────────────┘
                │
                ▼
       ┌────────────────┐
       │  Read replica  │
       │  (analytics)   │
       └────────────────┘
```

---

## Tech stack

### Backend

| Concern               | Library / Tool          | Notes                                                |
|-----------------------|------------------------|------------------------------------------------------|
| Framework             | NestJS 10              | Modular DI, decorators, OpenAPI, queue integration   |
| Runtime               | Node 20 LTS            | Pin in `.nvmrc` and Dockerfile                       |
| Language              | TypeScript 5.4+        | `strict: true`, no `any`                             |
| ORM                   | Prisma 5               | RLS via transaction wrapper                          |
| Validation            | Zod + nestjs-zod       | Schemas → types → OpenAPI                            |
| Queue                 | pg-boss                | Postgres-backed jobs                                 |
| Scheduler             | @nestjs/schedule       | Cron + intervals                                     |
| HTTP client           | axios                  | Already used in DigiNode; consistent surface         |
| Logging               | Pino + nestjs-pino     | Structured JSON, OTel-ready                          |
| Tracing               | OpenTelemetry Node SDK | OTLP exporter                                        |
| Auth                  | Passport (JWT)         | Refresh tokens; argon2 hashing                       |
| FHIR                  | `fhir` npm             | Same package as DigiNode                             |
| JWE / NHCX crypto     | `node-jose`            | Ported from DigiNode                                 |
| File uploads          | multer                 | Stream → S3 upload directly                          |
| Object store SDK      | @aws-sdk/client-s3     | Works with OVH S3-compatible endpoint                |
| Testing               | Jest + Supertest       | Unit + integration                                   |
| Test containers       | testcontainers-node    | Real Postgres + Redis in CI                          |
| Linting               | ESLint + typescript-eslint | Strict ruleset                                   |
| Formatting            | Prettier               | CI fails on diff                                     |
| Commit hooks          | Husky + lint-staged    | Pre-commit lint + test                               |

### Frontend

| Concern               | Library / Tool         | Notes                                                |
|-----------------------|-----------------------|------------------------------------------------------|
| Framework             | Next.js 14            | App Router, RSC where useful                         |
| UI library            | Custom + Radix UI     | Headless primitives, our token-driven styling        |
| Styling               | Tailwind CSS + tokens.css | Tailwind + CSS vars from `reference/tokens.css`  |
| State                 | TanStack Query        | Server state                                         |
| Local UI state        | Zustand               | Light, no Redux ceremony                             |
| Forms                 | React Hook Form + Zod | Same Zod schemas shared with API                     |
| Tables                | TanStack Table        | High-perf data grids for case lists                  |
| Charts                | Recharts or Chart.js  | Pick Recharts for v1                                 |
| Icons                 | lucide-react          | Tree-shakeable                                       |
| Date handling         | date-fns + date-fns-tz | India-zone aware                                    |
| HTTP client           | TanStack Query + ofetch / fetch | Type-safe via shared contracts             |
| E2E testing           | Playwright            | Component testing only, not portal scraping         |

### Shared

| Concern               | Library / Tool         | Notes                                                |
|-----------------------|-----------------------|------------------------------------------------------|
| Type sharing          | `@claims/contracts` workspace package | Zod schemas + TS types for all DTOs |
| Monorepo              | pnpm workspaces       | Lighter than Turborepo, sufficient                   |
| FHIR templates        | `@claims/fhir-templates` workspace package | JSON files ported from DigiNode             |

### Infrastructure

| Concern               | Choice                | Notes                                                |
|-----------------------|----------------------|------------------------------------------------------|
| Compute               | OVH Public Cloud VMs | Same as DigiSparsh                                   |
| Containers            | Docker + docker-compose | Multi-stage builds, distroless runtime base       |
| Reverse proxy         | Nginx                | Shared with DigiSparsh; path or subdomain split      |
| Database              | Postgres 16 (managed or self-hosted) | India region                          |
| Object storage        | OVH Object Storage   | S3-compatible, India region                          |
| Cache                 | Redis 7              | Sessions + rate limiting only                        |
| Secrets               | OVH KMS              | Tenant credentials wrapped, stored in Postgres       |
| CI/CD                 | GitHub Actions       | Build → test → push image → deploy                   |
| Logs / metrics        | Loki + Grafana + Prometheus (self-hosted) OR OVH Logs Data Platform | Pick self-hosted for v1 |
| Distributed tracing   | Tempo or Jaeger      | OTLP from API                                        |

---

## Module layout (inside the API)

The API is one process but organized into bounded modules. Each module exposes a service interface. Modules **never** import each other's repositories — only services. This is enforced by ESLint module boundaries.

```
apps/api/src/modules/
├── auth/             Login, JWT, refresh, RBAC
├── tenant/           Tenant CRUD, config, branding
├── user/             Hospital staff users, roles, permissions
├── patient/          Patient identity, demographics, ABHA linkage
├── policy/           Insurance policy capture, eligibility checks
├── pmjay-beneficiary/PMJAY beneficiary verification, family ID
├── case/             The "case" — top-level container that holds claims
├── preauth/          Pre-authorization lifecycle
├── enhancement/      Mid-stay enhancement requests
├── discharge/        Discharge submission
├── claim/            Final claim submission and tracking
├── query/            Communication / query response
├── settlement/       Payment, EOB parsing, reconciliation
├── analytics/        Denial analytics, AR ageing, dashboards
├── document/         Document storage abstraction
├── notification/     Email, SMS dispatch
├── audit/            Append-only audit log
├── admin/            Master data: payer, package, ICD codes
└── health/           Health check, readiness, liveness
```

Plus the integration gateway:

```
apps/api/src/integrations/
├── nhcx/             NHCX FHIR adapter (ported from DigiNode)
│   ├── messages/     Per-message-type builders
│   ├── crypto/       JWE encrypt/decrypt, session token
│   ├── fhir-templates/ JSON bundle templates
│   ├── callbacks/    Inbound callback handlers
│   └── nhcx.service.ts
├── pmjay/            PMJAY adapter
│   ├── api-adapter/  When NHA TMS API is available
│   ├── flow-engine/  YAML flow executor (v2)
│   ├── modes/        api | auto | assist | manual
│   └── pmjay.service.ts
├── abdm/             ABHA, HFR, HPR
└── shared/           Common: integration_message persistence, retry, circuit breaker
```

---

## Request lifecycle (NHCX preauth example)

1. **Client** (Next.js) sends `POST /api/v1/preauth` with claim payload.
2. **Auth guard** validates JWT, sets `request.user` and `request.tenantId`.
3. **Tenant interceptor** opens a Prisma `$transaction` that runs `SET LOCAL app.tenant_id = '<tenantId>'`. All queries inside this transaction respect RLS.
4. **Validation pipe** (Zod) parses and validates the payload against `PreauthCreateSchema`.
5. **Controller** calls `PreauthService.create(payload)`.
6. **Service**:
   - Loads the case, patient, policy from DB.
   - Validates business rules (e.g., policy is active, patient has consent).
   - Records a `claim_event` (type `preauth_initiated`).
   - Builds the FHIR Bundle via `NhcxService.buildPreauthBundle()`.
   - Persists the bundle to `nhcx_bundle` and an outbound row to `integration_message`.
   - Enqueues a `pg-boss` job `nhcx.send-preauth` with the bundle ID.
   - Returns 202 Accepted with the case's correlation ID.
7. **Worker** picks up the job:
   - Fetches the bundle.
   - Calls `NhcxService.sendBundle()` — this fetches a session token, JWE-encrypts the payload, and POSTs to the NHCX gateway with full headers (`x-hcx-correlation_id` etc.).
   - Records the response on the `integration_message` row and the `nhcx_bundle.bundleResponse`.
   - Records a `claim_event` (type `preauth_acknowledged_by_nhcx`).
8. **Some time later**, NHCX POSTs back to `/api/nhcx/callback/preauth/on_submit`:
   - Callback receiver authenticates the request (mTLS or signature check, depending on NHA's current spec).
   - Decrypts the JWE.
   - Records a `claim_event` (type `preauth_response_received`).
   - Updates `claim` materialised state.
   - Pushes a real-time notification (Server-Sent Events or WebSocket) to the connected frontend so the executive sees status update without refresh.

Every step is idempotent. Every external call writes both directions to `integration_message`. Every state change writes a `claim_event`.

---

## Tenant context propagation

A `TenantInterceptor` wraps every request:

```ts
// Pseudocode — note the parameterised set_config call.
// NEVER use $executeRawUnsafe with template-string interpolation of the tenant ID.
intercept(context, next) {
  const tenantId = extractTenantId(context.user);
  const role = extractRole(context.user); // "tenant" or "platform_admin"
  return this.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT
        set_config('app.tenant_id', ${tenantId}::text, true),
        set_config('app.role',      ${role}::text,      true)
    `;
    request.prisma = tx; // make tenant-scoped client available
    return next.handle().toPromise();
  });
}
```

`set_config(key, value, true)` is transaction-local (equivalent to `SET LOCAL`) and accepts parameterised values. This prevents SQL injection by construction: the tenant id is bound, never concatenated.

Inside the request, all DB access goes through `request.prisma`, never the global Prisma client. RLS policies on every tenant-scoped table reference the GUC. Net effect: a forgotten `WHERE tenant_id = ?` in application code cannot leak data — Postgres rejects the query.

CI test: a test case attempts a cross-tenant read and expects zero rows.

---

## Async work (queue-driven)

Job types in v1:

| Job                       | Trigger                        | Worker action                                     |
|---------------------------|-------------------------------|---------------------------------------------------|
| `nhcx.send-insurance`     | Service enqueues               | Encrypt + POST insurance plan request             |
| `nhcx.send-coverage`      | Service enqueues               | Encrypt + POST coverage eligibility               |
| `nhcx.send-preauth`       | Service enqueues               | Encrypt + POST preauth                            |
| `nhcx.send-enhancement`   | Service enqueues               | Encrypt + POST enhancement                        |
| `nhcx.send-discharge`     | Service enqueues               | Encrypt + POST discharge                          |
| `nhcx.send-claim`         | Service enqueues               | Encrypt + POST claim                              |
| `nhcx.send-communication` | Service enqueues               | Encrypt + POST query response                     |
| `nhcx.send-payment-notice`| Service enqueues               | Encrypt + POST payment notice                     |
| `nhcx.process-callback`   | Callback receiver enqueues     | Decrypt, persist, update claim state              |
| `pmjay.verify-beneficiary`| Service enqueues               | Call NHA BIS API                                  |
| `document.scan-virus`     | Document upload completes      | ClamAV scan                                       |
| `eob.parse`               | EOB upload completes           | OpenAI extraction → settlement reconciliation     |
| `notification.send-email` | Service enqueues               | Nodemailer send                                   |
| `notification.send-sms`   | Service enqueues               | TextGuru API                                      |
| `sla.evaluate`            | Cron (every 5 min)             | Find claims approaching SLA breach, alert         |
| `analytics.refresh-mvs`   | Cron (every 15 min)            | Refresh materialised views                        |
| `audit.archive`           | Cron (daily)                   | Move >90-day audit rows to cold storage           |

Workers run in separate containers but share the same codebase. Boot mode is selected via env: `MODE=api` or `MODE=worker`.

Idempotency: every job has a `job_key` (typically `<entity_type>:<entity_id>:<operation>`). pg-boss's `singletonKey` ensures we don't double-process.

---

## Observability

- **Logs**: Pino → stdout → Loki. Correlation ID per request, propagated to workers via job metadata. PII fields are redacted by a Pino redactor.
- **Metrics**: Prometheus client in NestJS. Per-endpoint latency, per-job duration, queue depth, NHCX response codes by message type.
- **Tracing**: OpenTelemetry. Every NHCX outbound call is a span. Worker jobs propagate the trace from the originating request.
- **Alerting**: Prometheus alertmanager → email + (optionally) WhatsApp via internal hook. Alert thresholds defined in `infra/alerts/`.

---

## Deployment topology on OVH

Two VMs at minimum:

```
VM-1 (api + workers + Redis)
  - Nginx (reverse proxy, also serves DigiSparsh)
  - claims-api container (NestJS in api mode)
  - claims-worker container (NestJS in worker mode, 2 replicas)
  - redis container
  - postgres container (or use OVH managed Postgres)
  - DigiSparsh containers (existing, untouched)

VM-2 (DR + analytics + monitoring)
  - postgres replica
  - prometheus + loki + grafana
  - tempo / jaeger
```

Domain plan:
- `app.claims.digisparsh.in` — Next.js frontend
- `api.claims.digisparsh.in` — NestJS API
- `gateway.digisparsh.in` — shared callback receiver (forwards to claims API or DigiSparsh based on path); URLs registered with NHA point here
- DigiSparsh continues at its existing URLs

CI deploys via GitHub Actions: build images, push to OVH Registry (or GHCR), SSH to VMs, `docker-compose pull && docker-compose up -d`.

---

## Failure handling principles

1. **Retry with backoff and a budget** — every external call retries up to 5 times with exponential backoff capped at 60s, then dead-letters into a `failed_job` queue for human review.
2. **Circuit breakers per integration** — when an integration's failure rate exceeds threshold, the breaker opens; new requests immediately return 503 with a code that maps to the "Payer system unavailable" modal. Auto-resets after a probe succeeds.
3. **Graceful degradation** — if NHCX is down, preauth submission queues but doesn't fail; the executive sees "Submission queued, will retry" instead of an error. Status is `submission_pending`.
4. **No silent failures** — every failure path writes an `integration_message` row with `status = 'failed'` and a classification. Daily report aggregates failures.

---

## Where the existing DigiSparsh stack fits

DigiSparsh stays operational. It handles:
- ABHA registration flows (existing module, not duplicated here)
- Lender / loan workflows (out of v1 scope)
- Other DigiSparsh modules (lending, world-line, ABDM operations)

The new claims platform reuses DigiSparsh's:
- Existing OVH host and Nginx
- ABHA-related services if needed (called as internal HTTP)
- Code patterns for NHCX (ported, not shared)

The new claims platform does **not** share a database with DigiSparsh. Cleaner ownership, cleaner scaling, cleaner compliance.

---

## What "production-ready" means

Before declaring a module production-ready:
- All endpoints have OpenAPI documentation generated by Swagger.
- All errors have entries in `reference/error-codes.md` and modal designs in the frontend.
- All state transitions appear in `docs/04-state-machines.md`.
- Coverage above gate.
- Integration tests pass against real Postgres + Redis (no mocks).
- Contract tests pass against the dummy NHCX payer.
- Load test: 50 concurrent insurance-desk users sustained for 30 minutes without degradation.
- DPDP / IRDAI checklist in `docs/08-compliance-and-security.md` complete.
