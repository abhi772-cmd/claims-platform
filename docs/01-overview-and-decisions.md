# 01 — Overview and Decisions Log

This is the project's decision diary. Every architectural choice is recorded here with what was considered, what was picked, why, and the conditions under which the decision should be revisited. New decisions get appended; superseded decisions stay (struck through) so the audit trail is intact.

---

## Executive summary

We are building a multi-tenant SaaS for Indian hospitals (10–500 beds) to manage the full claims lifecycle on two rails:

- **NHCX** — for private cashless and reimbursement claims via TPAs and insurers, using FHIR R4 over the NHA-operated National Health Claims Exchange.
- **PMJAY** — for Ayushman Bharat beneficiaries, integrating with NHA's Transaction Management System (TMS) where APIs exist, and with state portals via assist-mode (and later automation) where they don't.

The product does not replace the hospital's HIS. It integrates with the HIS via API/HL7/manual upload, owns the claim lifecycle, and is the system of record for every interaction with payers.

**MVP scope**: NHCX cashless preauth + claim + enhancement + payment; PMJAY preauth + claim in assist mode (executive uses portal, our platform tracks lifecycle); analytics dashboards; multi-tenant admin. Launch state: **Madhya Pradesh**. Target launch window: **4–6 months from kickoff**.

**Out of scope for v1**: lender on payment page, browser automation for PMJAY portals, ML denial prediction, WhatsApp notifications, native mobile app, dedicated DB tier for individual hospital chains.

---

## Problem context

Indian hospital insurance desks today operate in a fragmented stack: TPA portals (Medi Assist, Paramount, FHPL, Health India each with their own UI), the PMJAY/state portal, manual Excel trackers, email threads, paper handovers between desk executives, and reactive SLA management. Net result: clean claim rate stuck around 70–80% for most mid-sized hospitals, average 12–18% revenue leakage from short-paid and denied claims, and 30–60 days of average AR ageing on private claims.

A focused claims SaaS that owns the lifecycle, tracks every state change, predicts denials, and surfaces SLA risk reduces leakage and AR ageing measurably. The pricing pitch is per-claim or per-bed-month against a baseline of revenue recovered.

---

## Personas

### Primary (lives in the product 6+ hours/day)

- **Insurance desk executive** — files preauths, responds to queries, follows up on claims, raises enhancements. Power user. Keyboard-first navigation matters more than visual polish.

### Secondary (uses daily but in shorter sessions)

- **Billing manager** — supervises desk executives, handles escalations, reviews AR, runs reconciliation.
- **PMJAY arogya mitra (PMAM)** — handles only Ayushman cases. Different workflow, different portal, often a different person from the private claims executive.
- **Treating doctor** — provides clinical justification for preauth, signs off on documents. Occasional user. Frictionless flow is critical or they push back to nurses.

### Tertiary (uses weekly/monthly)

- **Hospital CFO / finance head** — lives in the analytics dashboards. Cares about AR, denial reasons, payer-wise margins.
- **Admin / IT** — sets up users, roles, payer master, document templates. Initial heavy use, then light.

### External (don't log in but shape the workflow)

- **TPA / insurer reviewer** — adjudicates the claim from the other side. Their workflow shapes ours.
- **NHA medical auditor** — reviews PMJAY claims after settlement. Audit trail must satisfy their queries.
- **Patient** — receives OTPs and consent prompts; no other touchpoints in v1.

---

## Decisions log

Each decision below is structured: **what we decided**, **what was considered**, **why we picked what we picked**, **revisit when**.

### D-001: Database — PostgreSQL, single primary, RLS multi-tenancy

**Decided**: PostgreSQL 16 with row-level security on a `tenant_id` column for tenant isolation. Single primary, one or two read replicas for analytics.

**Considered**: MongoDB (familiar to the team via DigiSparsh), MySQL, schema-per-tenant Postgres, database-per-tenant.

**Why**: Claims processing requires temporal correctness (event-sourced lifecycle), strong transactional guarantees (multi-table updates per claim event), partitioned audit tables (7-year retention), versioned master data, and full-text search. Postgres does all of this natively; Mongo fights you on every dimension. Schema-per-tenant doesn't scale past ~50 tenants and migrations become painful. Database-per-tenant is contractually relevant only for marquee hospital chains, not for v1.

**Revisit when**: A specific hospital chain demands contractual data isolation, OR row counts in `claim_event` exceed ~1B (consider sharding by tenant for hot tenants).

---

### D-002: Backend framework — NestJS on Node 20 LTS

**Decided**: NestJS 10 on Node 20 LTS, TypeScript strict.

**Considered**: FastAPI (Python), Express + TypeDI (DigiSparsh's existing pattern), Fastify, Spring Boot.

**Why**: NestJS gives module-bounded architecture, decorator-based DI, built-in validation pipes, OpenAPI generation via Swagger, and queue/scheduler integration out of the box. Node lets us reuse the working NHCX integration code from DigiNode (`nhcxfunctions.ts`, FHIR templates, dummy-payer harness, encryption with `node-jose`) — saving 4–6 weeks. TypeScript shared with the Next.js frontend eliminates a class of integration bugs. Express + TypeDI is too thin for a multi-tenant SaaS — we'd reimplement what NestJS gives free. FastAPI was the runner-up; lost on code reuse, type-sharing, and team continuity.

**Revisit when**: NestJS gets in our way for a specific module. Until then it's the default for everything.

---

### D-003: Frontend — Next.js 14 (App Router) + React 18

**Decided**: Next.js 14 with the App Router, React Server Components where they help, Server Actions for mutations where they help.

**Considered**: Vite + React Router, Remix, plain Angular (continuity with DigiSparsh).

**Why**: Insurance desk executives live in this UI 6+ hours/day. Next.js gives us server-side rendering for the heavy list/dashboard pages (denial analytics, claim tracker), client-side interactivity for forms, file-based routing that maps cleanly to module boundaries, and built-in image/font optimization. App Router's server components reduce JS shipped to the browser, which matters on hospital-grade laptops. Angular continuity isn't worth the cost — the existing DigiSparsh frontend is fine for what it does, but a fresh product deserves a fresh frontend, and Next.js is the modern default for SaaS dashboards.

**Revisit when**: Next.js's bundler or routing semantics meaningfully change in a way that hurts us. Lock to Next.js 14 LTS for v1; upgrade is a v2 ticket.

---

### D-004: ORM — Prisma 5

**Decided**: Prisma with the schema in `prisma/schema.prisma`, migrations via `prisma migrate`.

**Considered**: TypeORM (DigiSparsh familiarity), Drizzle, Kysely, raw `pg` with custom query builder.

**Why**: Prisma's developer experience for greenfield work is meaningfully better than TypeORM's. Schema-first definition, type-safe generated client, migration tooling, raw SQL escape hatch for the rare cases we need it. RLS plays well with Prisma via `$transaction` + `SET LOCAL`. Drizzle is good but younger and less battle-tested at scale. Kysely is too low-level for the speed we need.

**Risk**: Prisma's RLS support is not native — we wire it via a transaction wrapper that sets the GUC. Documented in `docs/03-data-model.md`.

**Revisit when**: Prisma blocks a specific feature (rare). Escape hatch is `prisma.$queryRaw` for that one query.

---

### D-005: Validation — Zod

**Decided**: Zod for all input validation; schemas double as TypeScript types via `z.infer`.

**Considered**: class-validator (NestJS default), Joi (DigiSparsh uses it), Yup.

**Why**: Zod's TypeScript inference is unmatched. One schema, runtime validation + compile-time types + OpenAPI generation (via `nestjs-zod`). class-validator works but its decorator-based approach diverges from how we share types with Next.js. Joi's TS support is weaker.

**Revisit when**: Never, probably. Zod is the standard.

---

### D-006: Queue — pg-boss (Postgres-backed)

**Decided**: pg-boss for async work in v1. All jobs persisted to Postgres.

**Considered**: BullMQ (Redis-backed), Hatchet, AWS SQS, RabbitMQ.

**Why**: Keeps queue durability inside Postgres (the same backup/restore story applies, no second persistence to operate). Job state is queryable by SQL — invaluable for ops. Throughput is plenty for v1 (hundreds of jobs/minute). BullMQ is faster but adds Redis-as-source-of-truth, which complicates DR. RabbitMQ/SQS are overkill.

**Revisit when**: Job throughput exceeds ~5k/min sustained. Switch to BullMQ for the hot lanes (NHCX outbound, callback receivers) and keep pg-boss for the rest.

---

### D-007: Multi-tenancy — shared schema, RLS, single DB

**Decided**: One database, every tenant-scoped table has a `tenant_id` column, Postgres RLS policies enforce tenant isolation. Application sets the tenant GUC at the start of every request.

**Considered**: Schema-per-tenant, database-per-tenant, application-only filtering.

**Why**: RLS is a hard floor. Application bugs cannot leak tenant data because the database itself rejects the query. Schema-per-tenant gets unmanageable past ~50 tenants and migrations are a nightmare. Database-per-tenant is for marquee customers later. Application-only filtering is a lawsuit waiting to happen — one missed `WHERE tenant_id = ?` and you've leaked data.

**Risk**: RLS policies are easy to forget on new tables. Mitigation: a CI check that scans the Prisma schema and ensures every `tenant_id`-bearing table has a corresponding policy migration.

**Revisit when**: A specific hospital chain demands their own database. Then we add a "dedicated tier" without changing the rest.

---

### D-008: Multi-rail UX — unified workflow with rail-aware affordances

**Decided**: The user sees the same workflow shell for NHCX and PMJAY claims. Status terminology is unified ("Pre-auth submitted", "Query raised", "Approved"). Rail-specific affordances appear inline (PMJAY package selector, NHCX policy lookup) based on the claim's rail.

**Considered**: Separate workflows per rail (two "tabs"), unified workflow with no rail distinction.

**Why**: Insurance desks often handle both rails for the same patient. Two separate workflows mean two mental models, two place to look. Unified workflow with rail-aware affordances keeps cognitive load low. Status terminology must be unified or analytics across rails becomes meaningless. The router decides what runs underneath; the executive sees one consistent UI.

**Revisit when**: User testing in pilot hospitals shows confusion. So far, this is the architectural intent.

---

### D-009: Browser automation — out of v1, designed in v2

**Decided**: V1 ships with manual + assist modes for PMJAY only. The automation framework (mode router, YAML flow definitions, Playwright executor, audit trail) is designed but not wired. V2 adds auto mode for the highest-volume MP-PMJAY operation (likely `submit_preauth`).

**Considered**: Auto from day 1, manual-only forever.

**Why**: Auto-from-day-1 risks a broken portal selector blocking launch. Manual-only forever caps the productivity ceiling. Designing the framework now means the v2 work is wiring, not architecture. The honest pitch to MP hospitals: "We make your PMJAY desk faster, more organized, and audit-ready. Automation is coming."

**Revisit when**: Any pilot hospital insists on day-1 automation as a procurement requirement. Then we accelerate v2 for that hospital's specific operation.

---

### D-010: Lender on payment page — out of scope

**Decided**: V1 ships without lender integration on the payment page. DigiSparsh's existing lender flow (`patientloans.ts`, `loanSchema.ts`, Worldline routes, Digio for signing) stays in DigiSparsh; we'll integrate when v1.x stabilises.

**Considered**: Build lender into v1.

**Why**: Lender integration is a meaningful regulatory surface (RBI digital lending norms, KFS, cooling-off, escrow accounts) that adds 4–6 weeks of work. V1's value comes from the claims lifecycle itself; the payment page can be lender-less initially. Hospitals that need lender today already have it via DigiSparsh.

**Revisit when**: Post-v1 launch, after first 5 customers are stable. Then design as a sub-module of Settlement.

---

### D-011: Hosting — alongside DigiSparsh on existing OVH

**Decided**: Same OVH host, same Nginx, new containers. Path-based routing or subdomain split, with NHA callback URLs unchanged so no re-whitelisting required at launch.

**Considered**: Separate OVH project, separate cloud (AWS), bare-metal.

**Why**: Operational simplicity. One environment to monitor. NHA URL whitelisting can stay as-is during launch; formal cutover happens later. AWS adds cost and a new toolchain. Bare-metal adds operational burden.

**Revisit when**: A single-tenant marquee customer demands isolated infrastructure, OR aggregate load on the OVH host requires horizontal scaling beyond what the current host can take.

---

### D-012: Compliance posture — DPDP-first, IRDAI-aligned, HIPAA-compatible

**Decided**: Treat DPDP Act 2023 as the primary compliance framework; align with IRDAI Health Insurance Regulations 2016 (and updates) for claim data handling; design infrastructure so it can be HIPAA-compatible if a customer demands it (encryption at rest with envelope keys, TLS 1.2+, access logs, BAA-able).

**Considered**: DPDP-only, ISO 27001 from day 1.

**Why**: DPDP is mandatory. IRDAI applies to claim data. HIPAA isn't strictly required (Indian patients aren't covered persons under HIPAA), but a HIPAA-aligned posture is sometimes a procurement requirement for hospitals serving foreign patients or for chains with US ties. Building HIPAA-compatible from day 1 is cheaper than retrofitting. ISO 27001 certification is a v2+ milestone (audits cost time and money).

**Revisit when**: A customer demands ISO 27001 or SOC 2. Both are achievable from this baseline with modest additional investment.

---

### D-013: Email — Nodemailer; SMS — TextGuru; WhatsApp — out

**Decided**: Email via Nodemailer (already used in DigiSparsh, SMTP-based, no per-message cost beyond the SMTP relay). SMS / OTP via TextGuru. WhatsApp out of v1.

**Why**: Reuse what works. Avoid extra recurring costs. WhatsApp-via-Gupshup adds vendor dependency without v1 ROI.

---

### D-014: EOB parsing — OpenAI API

**Decided**: EOB PDFs parsed via OpenAI API using free credits the user has access to. PDF text extraction with `pdf-parse`, structured extraction with the LLM.

**Considered**: pytesseract sidecar, manual entry only, regex-based parsers per payer.

**Why**: LLM-based extraction handles per-payer EOB format variation without brittle per-payer regex. Free tokens available to the user. Falls back to manual entry if extraction confidence is low.

**Revisit when**: Free token budget runs out, OR a specific TPA's EOB format is reliable enough to write a deterministic parser.

---

### D-015: Aadhaar / DigiLocker third-party verification — not used

**Decided**: V1 does not call third-party Aadhaar/DigiLocker verification APIs (Karza, Surepass, Hyperverge, etc.).

**Why**: ABHA verification is wrapped inside ABDM's own APIs. PMJAY beneficiary verification is wrapped inside NHA's BIS API. Both perform the underlying Aadhaar verification themselves. We never see the raw Aadhaar number, which is the right DPDP posture anyway. No third-party KYC vendor needed.

**Revisit when**: A new feature requires Aadhaar verification outside of ABHA/PMJAY contexts (e.g., cash-paying patient onboarding). Not on v1 roadmap.

---

### D-016: HSM — soft keys + OVH KMS in v1, network HSM in v2 at scale

**Decided**: V1 uses OVH KMS-encrypted private keys for FHIR Bundle JWS signing. The encrypted key blob lives in Postgres; decryption happens in-memory at signing time only.

**Considered**: SoftHSM, network HSM (Thales/Utimaco), AWS CloudHSM, Indian-region cloud HSM.

**Why**: V1 scale (1–10 hospitals) doesn't justify a ₹50k–₹1L/month HSM. OVH KMS gives us key wrapping, audit, and rotation at zero additional cost. Most NHCX participants today operate at this posture. Audit-ready.

**Revisit when**: A regulator audit explicitly requires HSM-grade signing, OR scale exceeds ~50 facilities.

---

### D-017: Browser-automation language — Node (Playwright Node)

**Decided**: When v2 adds automation, the executor is Node-based using Playwright Node SDK. Same TypeScript stack as the rest of the platform.

**Why**: Single-language stack. Shared types between API, frontend, and automation executor via `@digisparsh/contracts` package. Playwright Node is the most mature SDK.

---

### D-018: ML for denial prediction — out of v1, designed for v2

**Decided**: V1 collects the data needed (denial reasons, payer, package, claim metadata, outcome) into clean tables. No model in v1.

**Considered**: Build a basic logistic regression in v1.

**Why**: Without volume, the model is noise. V1's job is to instrument the world correctly so v2 has training data. Documented in the analytics module spec.

---

### D-019: PMJAY launch state — Madhya Pradesh

**Decided**: First go-live state is MP. Other states added one at a time after MP is stable.

**Why**: User has hospital relationships in MP. MP-specific PMJAY workflow is the first one we model deeply. Adding states later becomes a YAML/spec exercise rather than re-architecture.

---

### D-020: Browser automation — only when state portals require it

**Decided**: Automation framework stays dormant until an MP-specific operation either has no API or has an API that's actively unreliable. We do not automate operations that have working APIs.

**Why**: Automation is a maintenance tax. APIs are stable contracts. Use APIs first, automate only as a last resort.

---

### D-021: Field-level encryption — single platform key in v1, per-tenant keys post-pilot

**Decided**: V1 walking skeleton uses one platform-level PGP symmetric key wrapped by OVH KMS. Encrypted columns (PII fields suffixed `(enc)` in `docs/03-data-model.md`) decrypt via this single key. Per-tenant keys are deferred until after the first cohort of tenants reaches LIVE.

**Considered**: Per-tenant keys from day 1 (as originally sketched in `docs/03-data-model.md`).

**Why**: Per-tenant keys add real operational complexity that isn't justified at v1 scale: rotation while online, mid-run new-tenant provisioning without restart, multi-worker memory bloat (N workers × M tenants), and re-encryption windows during rotation. RLS already gates tenant access at the row level — a single platform key plus RLS is sufficient for the v1 threat model. The encryption helper API (`encrypt(field)` / `decrypt(field)`) is designed so the v2 upgrade to per-tenant keys is an internal change, not an API change.

**Risk**: A platform-key compromise exposes all tenants' encrypted columns at once. Mitigated by KMS-wrapped storage (key never on disk), short rotation cadence, and audit logging on every decrypt path.

**Revisit when**: First marquee customer demands cryptographic isolation, OR aggregate encrypted-column count makes a single-key compromise materially worse than RLS-only access.

---

### D-022: NHCX callback gateway trust boundary — OPEN, decide before NHCX sprint

**Status**: OPEN. Must be decided before any NHCX callback handler is written.

**Decision needed**: How does `gateway.digisparsh.in` route incoming NHCX callbacks between DigiSparsh and the claims platform when the payload is a JWE blob?

**Options**:
1. **Decrypt-at-gateway**: Gateway holds the decryption keys for both products, decrypts to inspect, then forwards. Simplifies upstream URL registration but collapses the trust boundary — a gateway compromise leaks both products' keys.
2. **Path-based routing**: NHA registers distinct callback paths per product (e.g., `/nhcx/digisparsh/...` vs `/nhcx/claims/...`). Gateway forwards purely on URL. Preserves isolation but requires re-whitelisting at NHA, which contradicts the D-011 promise of "no re-whitelisting at launch".
3. **Header-based routing with claims-platform-only handling**: Gateway forwards everything to the claims platform; the claims platform decrypts, and if the message is for DigiSparsh, posts internal-HTTP to it. Treats DigiSparsh as a downstream consumer.

**Why this is open**: Option 1 has the smallest infra change but the worst security posture. Option 2 is clean but breaks the launch story. Option 3 inverts the historical ownership and needs DigiSparsh team buy-in.

**Action**: Decide in the kickoff meeting for the NHCX integration sprint (out of walking-skeleton scope).

---

## How to add a new decision

1. Allocate the next D-NNN number.
2. Write what was decided, what was considered, why, and revisit-when.
3. Reference the decision in any code comments that depend on it (`// Per D-007, all multi-tenant queries set the tenant GUC`).
4. If the decision supersedes an earlier one, mark the earlier one ~~struck through~~ but leave it in place so the diff is auditable.

## How to revisit a decision

1. Open a discussion in the team Slack/email with a "Decision revisit: D-NNN" subject.
2. State what changed in the world that triggers the revisit.
3. Capture the new decision as D-NNN+something (don't reuse numbers), referencing the superseded one.
4. Update affected code and docs in the same PR.
