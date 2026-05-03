# 11 — Folder Structure

This is the actual on-disk shape of the repo. Concrete trees for both the API (NestJS) and Web (Next.js) projects, organized so a new engineer can find anything in two clicks.

The repo is a **pnpm workspace monorepo** with two apps and several shared packages.

---

## Top-level

```
claims-platform/                                  ← repo root
├── apps/
│   ├── api/                                      ← NestJS API
│   └── web/                                      ← Next.js frontend
├── packages/
│   ├── contracts/                                ← shared Zod schemas + TS types
│   ├── fhir-templates/                           ← FHIR JSON bundle templates (ported from DigiNode)
│   ├── error-codes/                              ← generated error code constants (from reference/error-codes.md)
│   ├── ui-tokens/                                ← compiled tokens.css for both web and admin
│   └── eslint-config/                            ← shared ESLint config
├── infra/
│   ├── docker/                                   ← Dockerfiles per service
│   ├── docker-compose/
│   │   ├── docker-compose.dev.yml
│   │   ├── docker-compose.prod.yml
│   │   └── docker-compose.test.yml
│   ├── nginx/                                    ← Nginx config (alongside DigiSparsh's existing nginx folder)
│   ├── runbooks/
│   │   ├── breach.md
│   │   ├── outage.md
│   │   ├── nhcx-cert-rotation.md
│   │   └── pmjay-portal-change.md
│   └── scripts/                                  ← deployment, seeding, backup, restore
├── docs/                                         ← the spec docs (THIS folder)
├── reference/                                    ← error codes, tokens, etc.
├── scaffolding/                                  ← initial folder trees (this file's friends)
├── .github/
│   └── workflows/                                ← CI pipelines
├── .vscode/
│   └── settings.json                             ← shared editor settings
├── .nvmrc                                        ← pin Node 20.x
├── .editorconfig
├── pnpm-workspace.yaml
├── package.json                                  ← root scripts (lint:all, test:all, build:all)
├── turbo.json (optional, if scale demands)
├── tsconfig.base.json
├── prettier.config.js
├── README.md
└── CLAUDE.md
```

---

## apps/api/ — NestJS API

```
apps/api/
├── src/
│   ├── main.ts                                   ← entrypoint; selects api or worker mode
│   ├── app.module.ts                             ← root module composition
│   ├── config/
│   │   ├── configuration.ts                      ← typed env loader (Zod-validated)
│   │   ├── env.schema.ts
│   │   └── secrets.ts                            ← OVH KMS unwrap on boot
│   ├── common/                                   ← cross-cutting concerns
│   │   ├── decorators/
│   │   │   ├── current-user.decorator.ts
│   │   │   ├── tenant-id.decorator.ts
│   │   │   └── redacted-logger.decorator.ts
│   │   ├── filters/
│   │   │   ├── domain-exception.filter.ts
│   │   │   └── http-exception.filter.ts
│   │   ├── guards/
│   │   │   ├── jwt-auth.guard.ts
│   │   │   ├── tenant.guard.ts
│   │   │   └── roles.guard.ts
│   │   ├── interceptors/
│   │   │   ├── tenant.interceptor.ts             ← sets Postgres GUC
│   │   │   ├── audit.interceptor.ts
│   │   │   ├── correlation-id.interceptor.ts
│   │   │   └── timing.interceptor.ts
│   │   ├── pipes/
│   │   │   └── zod-validation.pipe.ts
│   │   ├── errors/
│   │   │   ├── domain-error.ts                   ← base class
│   │   │   └── error-titles.ts                   ← code → title map
│   │   └── prisma/
│   │       ├── prisma.module.ts
│   │       ├── prisma.service.ts                 ← exposes both raw and tenant-scoped clients
│   │       └── tenant-context.service.ts
│   ├── modules/
│   │   ├── auth/
│   │   │   ├── auth.module.ts
│   │   │   ├── auth.controller.ts
│   │   │   ├── auth.service.ts
│   │   │   ├── auth.service.spec.ts
│   │   │   ├── jwt.strategy.ts
│   │   │   ├── mfa.service.ts
│   │   │   ├── refresh-token.service.ts
│   │   │   ├── dto/
│   │   │   │   ├── login.dto.ts
│   │   │   │   ├── refresh.dto.ts
│   │   │   │   └── mfa.dto.ts
│   │   │   ├── errors/
│   │   │   │   └── auth-errors.ts
│   │   │   └── README.md                         ← module-level CLAUDE.md (what this owns)
│   │   ├── tenant/
│   │   ├── user/
│   │   ├── patient/
│   │   ├── policy/
│   │   ├── pmjay-beneficiary/
│   │   ├── case/
│   │   ├── preauth/
│   │   │   ├── preauth.module.ts
│   │   │   ├── preauth.controller.ts
│   │   │   ├── preauth.service.ts
│   │   │   ├── preauth.state-machine.ts
│   │   │   ├── preauth.state-machine.spec.ts
│   │   │   ├── package-suggestion.service.ts
│   │   │   ├── doctor-signature.service.ts
│   │   │   ├── dto/
│   │   │   ├── errors/
│   │   │   ├── events/
│   │   │   │   ├── preauth-submitted.event.ts
│   │   │   │   └── preauth-approved.event.ts
│   │   │   └── README.md
│   │   ├── enhancement/
│   │   ├── discharge/
│   │   ├── claim/
│   │   ├── query/
│   │   ├── settlement/
│   │   │   ├── settlement.service.ts
│   │   │   ├── eob-parse.service.ts
│   │   │   ├── reconciliation.service.ts
│   │   │   ├── appeal.service.ts
│   │   │   └── ...
│   │   ├── analytics/
│   │   │   ├── analytics.module.ts
│   │   │   ├── analytics.service.ts              ← reads from materialized views
│   │   │   ├── reports/
│   │   │   │   ├── denial-reasons.ts
│   │   │   │   ├── ar-ageing.ts
│   │   │   │   ├── cash-forecast.ts
│   │   │   │   └── ...
│   │   │   └── ...
│   │   ├── document/
│   │   │   ├── document.service.ts
│   │   │   ├── upload.controller.ts
│   │   │   ├── virus-scan.service.ts
│   │   │   ├── checklist.service.ts
│   │   │   └── storage.adapter.ts                ← OVH Object Storage abstraction
│   │   ├── notification/
│   │   │   ├── notification.service.ts
│   │   │   ├── email.adapter.ts                  ← Nodemailer
│   │   │   ├── sms.adapter.ts                    ← TextGuru
│   │   │   ├── templates/
│   │   │   │   ├── preauth-approved.template.ts
│   │   │   │   ├── query-received.template.ts
│   │   │   │   └── ...
│   │   │   └── ...
│   │   ├── audit/
│   │   ├── admin/
│   │   │   ├── admin.module.ts
│   │   │   ├── tenant-admin.service.ts
│   │   │   ├── user-admin.service.ts
│   │   │   ├── payer-master.service.ts
│   │   │   ├── package-master.service.ts
│   │   │   └── ...
│   │   ├── consent/
│   │   ├── realtime/                             ← SSE for live status updates
│   │   └── health/
│   ├── integrations/
│   │   ├── nhcx/
│   │   │   ├── nhcx.module.ts
│   │   │   ├── nhcx.service.ts                   ← orchestrates outbound
│   │   │   ├── crypto/
│   │   │   │   ├── jwe-encrypt.ts                ← ported from nhcxfunctions.ts
│   │   │   │   ├── jwe-decrypt.ts
│   │   │   │   ├── session-token.service.ts
│   │   │   │   └── cert-loader.ts
│   │   │   ├── messages/
│   │   │   │   ├── insurance-plan.builder.ts
│   │   │   │   ├── coverage-eligibility.builder.ts
│   │   │   │   ├── preauth.builder.ts
│   │   │   │   ├── enhancement.builder.ts
│   │   │   │   ├── discharge.builder.ts
│   │   │   │   ├── claim.builder.ts
│   │   │   │   ├── communication.builder.ts
│   │   │   │   └── payment-notice.builder.ts
│   │   │   ├── callbacks/
│   │   │   │   ├── callback.controller.ts
│   │   │   │   └── callback-router.service.ts
│   │   │   ├── workers/
│   │   │   │   ├── send-preauth.worker.ts
│   │   │   │   ├── send-claim.worker.ts
│   │   │   │   └── process-callback.worker.ts
│   │   │   ├── headers/
│   │   │   │   └── nhcx-headers.ts
│   │   │   └── README.md
│   │   ├── pmjay/
│   │   │   ├── pmjay.module.ts
│   │   │   ├── pmjay.service.ts
│   │   │   ├── api/
│   │   │   │   ├── bis.service.ts                ← beneficiary verification
│   │   │   │   └── tms.adapter.ts                ← if/where APIs exist
│   │   │   ├── modes/
│   │   │   │   ├── mode-router.ts
│   │   │   │   ├── api.mode.ts
│   │   │   │   ├── auto.mode.ts                  ← v2 only
│   │   │   │   ├── assist.mode.ts                ← v1 default for portal-only ops
│   │   │   │   └── manual.mode.ts
│   │   │   ├── flows/                            ← v2: YAML flow definitions per state
│   │   │   │   └── MP/
│   │   │   │       ├── submit_preauth.yaml
│   │   │   │       ├── submit_claim.yaml
│   │   │   │       └── respond_to_query.yaml
│   │   │   ├── flow-engine/                      ← v2 executor
│   │   │   │   ├── executor.ts
│   │   │   │   ├── action-handlers/
│   │   │   │   ├── browser-pool.ts
│   │   │   │   ├── audit-recorder.ts
│   │   │   │   └── failure-classifier.ts
│   │   │   ├── packages/
│   │   │   │   └── package-master.service.ts
│   │   │   ├── assist/
│   │   │   │   ├── assist-payload.service.ts     ← generates the side-panel content
│   │   │   │   └── assist.controller.ts
│   │   │   ├── health/
│   │   │   │   ├── smoke-test.service.ts         ← v2: daily smoke tests per state-op
│   │   │   │   └── degradation-detector.ts
│   │   │   └── README.md
│   │   ├── abdm/
│   │   │   ├── abdm.module.ts
│   │   │   ├── abha.service.ts
│   │   │   ├── hfr.service.ts
│   │   │   └── hpr.service.ts
│   │   ├── openai/
│   │   │   └── eob-parser.service.ts
│   │   ├── textguru/
│   │   │   └── sms.adapter.ts
│   │   ├── nodemailer/
│   │   │   └── email.adapter.ts
│   │   └── shared/
│   │       ├── integration-message.repository.ts
│   │       ├── retry-with-backoff.ts
│   │       ├── circuit-breaker.ts
│   │       └── idempotency.service.ts
│   ├── queue/
│   │   ├── queue.module.ts
│   │   ├── queue.service.ts                       ← pg-boss wrapper
│   │   ├── job-types.ts
│   │   └── workers/                               ← worker boot in worker mode
│   │       ├── nhcx.worker.ts
│   │       ├── document.worker.ts
│   │       ├── notification.worker.ts
│   │       └── sla.cron.ts
│   ├── database/
│   │   ├── postgres-extensions.sql                ← pgcrypto, pgaudit, pg_partman, pgvector
│   │   ├── rls-policies.sql                       ← all RLS policies in one file (read in CI)
│   │   ├── partitions.sql                         ← partition setup for event/audit tables
│   │   └── functions.sql                          ← any custom Postgres functions
│   └── types/
│       └── express/
│           └── index.d.ts                         ← Express request augmentation
├── prisma/
│   ├── schema.prisma                              ← single source of truth
│   ├── migrations/                                ← timestamped migration files
│   │   └── 20260201000000_init/
│   │       └── migration.sql
│   └── seed.ts                                    ← idempotent seed
├── test/
│   ├── integration/
│   │   ├── auth.e2e-spec.ts
│   │   ├── preauth.e2e-spec.ts
│   │   ├── claim.e2e-spec.ts
│   │   ├── nhcx-callbacks.e2e-spec.ts
│   │   └── tenant-isolation.e2e-spec.ts            ← cross-tenant access verified blocked
│   ├── contract/                                   ← contract tests against dummy NHCX payer
│   │   ├── preauth-bundle.spec.ts
│   │   └── claim-bundle.spec.ts
│   ├── fixtures/
│   └── jest-e2e.json
├── nest-cli.json
├── tsconfig.json
├── tsconfig.build.json
├── jest.config.ts
├── package.json
└── README.md                                       ← API-specific README
```

### Module-level READMEs

Each `modules/<name>/README.md` is a short doc:
- What this module owns (one paragraph)
- What it depends on (other modules / integrations)
- Public service interface (just method signatures)
- Where its tests live
- Where its endpoints are documented

This is what Claude reads when navigating into a module to add a feature.

---

## apps/web/ — Next.js frontend

```
apps/web/
├── app/                                             ← App Router
│   ├── layout.tsx                                   ← root layout: ThemeProvider, AuthProvider, ToastProvider, ErrorModalProvider
│   ├── page.tsx                                     ← redirects to /dashboard or /login
│   ├── globals.css                                  ← imports tokens.css and Tailwind
│   ├── (auth)/                                      ← route group (no layout for auth)
│   │   ├── layout.tsx
│   │   ├── login/
│   │   │   └── page.tsx
│   │   ├── reset-password/
│   │   │   └── page.tsx
│   │   └── doctor-sign/
│   │       └── [token]/
│   │           └── page.tsx                         ← short-lived doctor signature flow
│   ├── (dashboard)/                                 ← authenticated app
│   │   ├── layout.tsx                               ← AppShell with sidebar + topbar
│   │   ├── dashboard/
│   │   │   └── page.tsx                             ← landing dashboard
│   │   ├── cases/
│   │   │   ├── page.tsx                             ← cases list
│   │   │   ├── new/
│   │   │   │   └── page.tsx
│   │   │   └── [caseId]/
│   │   │       ├── page.tsx                         ← case detail
│   │   │       ├── timeline/
│   │   │       │   └── page.tsx
│   │   │       └── documents/
│   │   │           └── page.tsx
│   │   ├── preauth/
│   │   │   ├── page.tsx                             ← preauth queue
│   │   │   └── [preauthId]/
│   │   │       ├── page.tsx
│   │   │       ├── edit/
│   │   │       │   └── page.tsx
│   │   │       ├── queries/
│   │   │       │   └── [queryId]/
│   │   │       │       └── page.tsx
│   │   │       └── pmjay-assist/
│   │   │           └── page.tsx
│   │   ├── enhancement/
│   │   ├── discharge/
│   │   ├── claim/
│   │   ├── settlement/
│   │   │   ├── page.tsx                             ← settlement queue
│   │   │   └── [claimId]/
│   │   │       └── page.tsx                         ← reconciliation detail
│   │   ├── analytics/
│   │   │   ├── page.tsx                             ← analytics overview
│   │   │   ├── denials/
│   │   │   │   └── page.tsx
│   │   │   ├── tat/
│   │   │   ├── ar-ageing/
│   │   │   ├── pmjay-packages/
│   │   │   └── cash-forecast/
│   │   ├── admin/
│   │   │   ├── users/
│   │   │   ├── roles/
│   │   │   ├── payers/
│   │   │   ├── packages/
│   │   │   └── document-checklists/
│   │   └── profile/
│   │       └── page.tsx
│   ├── api/                                          ← Next.js API routes (only for what shouldn't go to NestJS)
│   │   └── auth/
│   │       └── callback/
│   │           └── route.ts                          ← optional OAuth, etc.
│   └── not-found.tsx
├── components/
│   ├── ui/                                            ← design system primitives
│   │   ├── Button/
│   │   ├── Card/
│   │   ├── Input/
│   │   ├── Select/
│   │   ├── DatePicker/
│   │   ├── DataTable/
│   │   ├── Modal/
│   │   ├── StatusBadge/
│   │   ├── RailBadge/
│   │   ├── SlaBadge/
│   │   ├── EmptyState/
│   │   ├── Skeleton/
│   │   ├── Tabs/
│   │   └── Toast/
│   ├── forms/
│   │   ├── PreauthForm/
│   │   ├── ClaimForm/
│   │   ├── EnhancementForm/
│   │   ├── DischargeForm/
│   │   ├── DocumentUploader/
│   │   ├── PolicyLookupForm/
│   │   ├── PmjayBeneficiaryForm/
│   │   ├── PackageSelector/
│   │   └── QueryResponseForm/
│   ├── modals/
│   │   ├── ErrorModal/
│   │   │   ├── ErrorModal.tsx
│   │   │   ├── error-map.ts                          ← imported from @claims/error-codes
│   │   │   └── ErrorModal.spec.tsx
│   │   ├── ConfirmModal/
│   │   ├── DocumentPreviewModal/
│   │   ├── PmjayAssistModal/
│   │   └── ConsentModal/
│   ├── feedback/
│   │   ├── Toast/
│   │   ├── ProgressBar/
│   │   └── LoadingShimmer/
│   ├── layouts/
│   │   ├── AppShell/
│   │   ├── PageHeader/
│   │   └── PageContent/
│   ├── data/
│   │   ├── ClaimCard/
│   │   ├── ClaimTimeline/
│   │   ├── CaseSummary/
│   │   ├── EobViewer/
│   │   ├── DocumentChecklist/
│   │   └── KeyValueGrid/
│   └── icons/
├── lib/
│   ├── api/
│   │   ├── client.ts                                 ← typed API client
│   │   ├── claim.api.ts
│   │   ├── preauth.api.ts
│   │   └── ...
│   ├── auth/
│   │   ├── session.ts
│   │   └── permissions.ts
│   ├── claim/
│   │   ├── status-labels.ts                          ← ClaimStatus → label map
│   │   ├── status-colors.ts                          ← ClaimStatus → color token map
│   │   └── transitions.ts
│   ├── hooks/
│   │   ├── useErrorModal.ts
│   │   ├── useToast.ts
│   │   ├── useConfirm.ts
│   │   ├── useSse.ts
│   │   └── useDebounce.ts
│   ├── state/
│   │   ├── error-modal.store.ts
│   │   ├── toast.store.ts
│   │   └── tenant.store.ts
│   ├── utils/
│   │   ├── formatDate.ts
│   │   ├── formatCurrency.ts
│   │   └── classnames.ts
│   ├── types/
│   │   └── index.ts                                  ← re-exports from @claims/contracts
│   └── i18n/                                          ← future
├── public/
│   ├── images/
│   └── fonts/
├── styles/
│   └── tokens.css                                    ← copied from packages/ui-tokens
├── __tests__/
│   ├── unit/
│   └── e2e/
│       └── playwright/
├── next.config.js
├── tailwind.config.ts
├── postcss.config.js
├── tsconfig.json
├── package.json
└── README.md
```

---

## packages/ — shared packages

### `packages/contracts/`

```
packages/contracts/
├── src/
│   ├── auth.schema.ts                              ← Zod schemas for auth payloads
│   ├── claim.schema.ts
│   ├── preauth.schema.ts
│   ├── policy.schema.ts
│   ├── document.schema.ts
│   ├── analytics.schema.ts
│   ├── status.ts                                   ← ClaimStatus enum
│   ├── error-codes.ts                              ← generated from reference/error-codes.md
│   └── index.ts                                    ← re-exports
├── package.json
└── tsconfig.json
```

### `packages/fhir-templates/`

```
packages/fhir-templates/
├── src/
│   ├── insurance-plan.template.ts                   ← was insurancebundle.json
│   ├── coverage-eligibility.template.ts
│   ├── preauth.template.ts                          ← was Pre-Auth.json
│   ├── enhancement.template.ts                     ← was enhancementRequest.json
│   ├── discharge.template.ts                       ← was dischargeRequest.json
│   ├── claim.template.ts                            ← was claimRequest.json
│   ├── communication.template.ts                   ← was communicationbundle.json
│   ├── coverage-eligibility-request.template.ts    ← was coverageEligibilityRequest.json
│   └── index.ts
├── package.json
└── tsconfig.json
```

### `packages/error-codes/`

```
packages/error-codes/
├── src/
│   ├── codes.ts                                     ← generated; do not edit
│   ├── titles.ts                                    ← generated
│   └── index.ts
├── scripts/
│   └── generate-from-md.ts                          ← reads reference/error-codes.md
├── package.json
└── tsconfig.json
```

### `packages/ui-tokens/`

```
packages/ui-tokens/
├── src/
│   ├── tokens.css                                   ← canonical CSS variables
│   └── tokens.ts                                    ← TypeScript exports for use in components
├── package.json
└── tsconfig.json
```

### `packages/eslint-config/`

```
packages/eslint-config/
├── index.js                                         ← shared ESLint config
└── package.json
```

---

## .github/workflows/ — CI

```
.github/workflows/
├── ci.yml                                           ← lint, type-check, test, build on every push
├── deploy-staging.yml                               ← deploy to staging on merge to main
├── deploy-prod.yml                                  ← manual deploy to prod
├── security-scan.yml                                ← weekly Trivy + Snyk
└── error-codes-validate.yml                         ← validates error-codes.md ↔ code consistency
```

---

## infra/

```
infra/
├── docker/
│   ├── api.Dockerfile                               ← multi-stage; runtime is distroless
│   ├── web.Dockerfile
│   └── worker.Dockerfile                            ← can also be the api image with MODE=worker
├── docker-compose/
│   ├── docker-compose.dev.yml                       ← local dev: postgres, redis, mailhog
│   ├── docker-compose.test.yml                      ← CI: postgres + redis + minio (for tests)
│   └── docker-compose.prod.yml                      ← production composition
├── nginx/
│   ├── nginx.conf
│   ├── claims-platform.conf                         ← per-app vhost
│   └── shared-callbacks.conf                        ← NHCX callback routing (forwards to claims OR digisparsh)
├── runbooks/
└── scripts/
    ├── seed-payers.ts
    ├── seed-packages.ts
    ├── seed-icd-codes.ts
    ├── backup.sh
    ├── restore.sh
    ├── rotate-nhcx-cert.sh
    └── deploy.sh
```

---

## Naming conventions

- **Files**: `kebab-case.ts` for TypeScript modules; `PascalCase.tsx` for React components.
- **Folders**: `kebab-case/` everywhere.
- **Test files**: `*.spec.ts` (unit, alongside source) and `*.e2e-spec.ts` (integration, in `test/`).
- **Module names** in NestJS: `<Domain>Module` (PascalCase class), folder `<domain>/` (kebab-case).
- **Service classes**: `<Domain>Service`.
- **Controller classes**: `<Domain>Controller`.

---

## Path aliases

Configured in each `tsconfig.json` to avoid `../../../`:

```json
"paths": {
  "@/*": ["src/*"],
  "@common/*": ["src/common/*"],
  "@modules/*": ["src/modules/*"],
  "@integrations/*": ["src/integrations/*"],
  "@queue/*": ["src/queue/*"],
  "@claims/contracts": ["../../packages/contracts/src"],
  "@claims/fhir-templates": ["../../packages/fhir-templates/src"],
  "@claims/error-codes": ["../../packages/error-codes/src"],
  "@claims/ui-tokens": ["../../packages/ui-tokens/src"]
}
```

---

## Quick navigation cheatsheet

If you want to...

| ...do this                                   | ...go here                                                      |
|----------------------------------------------|-----------------------------------------------------------------|
| Add a new claim status                        | `apps/api/src/modules/claim/claim.status.ts` + state machine + `apps/web/lib/claim/status-labels.ts` + `docs/04-state-machines.md` |
| Add a new error                              | `apps/api/src/modules/<domain>/errors/` + `reference/error-codes.md` + `apps/web/components/modals/error-map.ts` |
| Add a new NHCX message type                  | `apps/api/src/integrations/nhcx/messages/` + `packages/fhir-templates/` + `docs/07-nhcx-and-pmjay.md` |
| Add a new endpoint                           | `apps/api/src/modules/<domain>/<domain>.controller.ts` + DTO + service method + `docs/05-user-journeys.md` |
| Add a new module                             | `apps/api/src/modules/<domain>/` (use the Nest CLI: `nest g module <domain>`) + `docs/06-modules.md` |
| Change DB schema                             | `apps/api/prisma/schema.prisma` → `pnpm prisma migrate dev --name <change>` |
| Add a UI component                           | `apps/web/components/<category>/<ComponentName>/` |
| Add a new page route                         | `apps/web/app/(dashboard)/<route>/page.tsx` |
| Update color tokens                          | `packages/ui-tokens/src/tokens.css` (rebuilds for both apps) |
