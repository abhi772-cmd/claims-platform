# DigiSparsh Claims Platform — Implementation Documentation

A multi-tenant claims processing SaaS for Indian hospitals. Two rails: NHCX for private cashless and reimbursement, PMJAY for Ayushman Bharat. Postgres-backed, NestJS API, Next.js frontend, deployed alongside the existing DigiSparsh stack on OVH.

This folder is the single source of truth that engineers and Claude (in VS Code) read while building the product. Treat every doc here as canonical. If something here is wrong, fix the doc first, then change code.

---

## How to read this folder

Start at `CLAUDE.md` if you're Claude, then read the relevant module doc for the task at hand. Start at `docs/01-overview-and-decisions.md` if you're a human onboarding to the project.

```
claims-platform/
├── README.md                      ← you are here
├── CLAUDE.md                      ← root instructions Claude Code auto-loads
├── docs/
│   ├── 01-overview-and-decisions.md     Executive summary + decision log (think-twice rationale)
│   ├── 02-architecture-and-stack.md     System architecture, tech stack, deployment
│   ├── 03-data-model.md                 Prisma schema design, RLS, event sourcing
│   ├── 04-state-machines.md             Claim lifecycle, status mapping, automation states
│   ├── 05-user-journeys.md              Personas + journeys + endpoint mapping
│   ├── 06-modules.md                    Module breakdown and responsibilities
│   ├── 07-nhcx-and-pmjay.md             Integration specs for both rails
│   ├── 08-compliance-and-security.md    DPDP, IRDAI, HIPAA-aligned, NHA empanelment
│   ├── 09-design-system.md              Colors, typography, component patterns
│   ├── 10-error-modal-system.md         Error codes ↔ modal messages (exhaustive)
│   ├── 11-folder-structure.md           Concrete repo scaffolding
│   ├── 12-development-workflow.md       Coding standards, testing, CI, branching
│   ├── 13-claude-vscode-workflow.md     How to use Claude in VS Code with this PRD
│   └── 14-onboarding-and-auth.md        Hospital onboarding lifecycle, setup wizard, full auth flows, RBAC matrix
├── reference/
│   ├── tokens.css                  CSS variables ready to drop into Next.js
│   └── error-codes.md              Lookup table — every error, every modal
└── scaffolding/
    ├── backend-tree.txt            Backend folder structure (NestJS)
    └── frontend-tree.txt           Frontend folder structure (Next.js)
```

---

## V1 in one paragraph

NestJS API + Next.js (App Router) frontend, single Postgres 16 with RLS-based multi-tenancy and pgmq/pg-boss for async work, deployed as Docker containers on the existing OVH host behind the same Nginx that already serves DigiSparsh. Rails: NHCX (FHIR R4, fully API-integrated, ported from DigiNode) and PMJAY (manual + assist mode for v1, automation framework wired but inactive). MP launch first. Lender flow shelved. No browser automation in v1; YAML-driven Playwright executor lands in v2.

## Stack at a glance

| Concern              | Choice                                  |
|----------------------|-----------------------------------------|
| Backend              | NestJS 10 on Node 20 LTS                |
| Frontend             | Next.js 14 (App Router) + React 18      |
| Language             | TypeScript everywhere, `strict: true`   |
| Database             | PostgreSQL 16 with RLS                  |
| ORM                  | Prisma 5                                |
| Validation           | Zod                                     |
| Queue                | pg-boss (Postgres-backed)               |
| Cache / sessions     | Redis 7                                 |
| Object storage       | OVH Object Storage (S3-compatible)      |
| Logging              | Pino + OpenTelemetry                    |
| Auth                 | Passport (JWT + refresh) + Argon2       |
| FHIR                 | `fhir` npm package                      |
| JWE / NHCX crypto    | `node-jose` (ported from DigiNode)      |
| Browser automation   | Playwright Node (v2 only)               |
| Email                | Nodemailer                              |
| SMS / OTP            | TextGuru                                |
| LLM (EOB parsing)    | OpenAI API                              |
| Deployment           | Docker + docker-compose on OVH          |
| Reverse proxy        | Nginx (shared with DigiSparsh)          |
| CI/CD                | GitHub Actions                          |

## Out of scope for v1

- Lender integration on the payment page (parked, revisit post-launch)
- PMJAY browser automation (auto mode designed but disabled — assist mode ships)
- ML denial prediction (data-collection only in v1; model trains in v2)
- WhatsApp notifications (Nodemailer + TextGuru SMS only in v1)
- Hospital chains with database-per-tenant tier (single shared DB with RLS)
- Mobile native app (responsive web only)

## Key principles

1. **Postgres is the source of truth.** Everything else (queues, Redis, object store) is replaceable. The schema is sacred.
2. **Every claim transition is an event.** `claim_event` is append-only. The claim's current state is materialised; the events are immutable history.
3. **Tenant isolation is enforced at the database level.** RLS policies are a hard floor, not a soft suggestion. Application bugs must not be able to leak tenant data.
4. **Errors are domain events, not exceptions.** Every user-visible error has a code, a modal, and an audit trail.
5. **NHCX and PMJAY differ in plumbing, not in user experience.** The executive sees the same UI with rail-aware affordances. The router decides what runs underneath.
6. **One language across the stack.** TypeScript on the server, in the browser, in tests, in build scripts. No Python sidecars in v1.
7. **The dev who reads this doc 6 months from now is the most important reader.** Document why, not just what.
