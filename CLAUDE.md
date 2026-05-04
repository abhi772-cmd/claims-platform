# Project Instructions for Claude

You are working on **DigiSparsh Claims Platform**, a multi-tenant claims processing SaaS for Indian hospitals integrating NHCX (private cashless and reimbursement) and PMJAY (Ayushman Bharat). Read this file before doing anything else. If a task seems to conflict with these instructions, surface the conflict in plan mode rather than guessing.

## Where the spec lives

The full PRD is in `docs/`. Read the doc most relevant to the task at hand before coding. Specifically:

- **Decisions / why** — `docs/01-overview-and-decisions.md`
- **Architecture / how the pieces fit** — `docs/02-architecture-and-stack.md`
- **Data model and Prisma** — `docs/03-data-model.md`
- **Status state machine** — `docs/04-state-machines.md`
- **User journeys + endpoints** — `docs/05-user-journeys.md`
- **Module responsibilities** — `docs/06-modules.md`
- **NHCX and PMJAY integration** — `docs/07-nhcx-and-pmjay.md`
- **Compliance** — `docs/08-compliance-and-security.md`
- **Design system / colors** — `docs/09-design-system.md`
- **Error → modal mapping** — `docs/10-error-modal-system.md` and `reference/error-codes.md`
- **Folder structure** — `docs/11-folder-structure.md`
- **Hospital onboarding & auth (RBAC, setup wizard, MFA, doctor flow)** — `docs/14-onboarding-and-auth.md`

If the user asks for a feature, your first move is to find the matching section in these docs. If the docs don't cover it, **stop and ask** rather than inventing. New decisions get written into `docs/01-overview-and-decisions.md` before any code is written.

## Hard rules

These are not preferences. Breaking them is breaking the product.

1. **TypeScript strict mode is non-negotiable.** No `any`. No `@ts-ignore`. No type assertions without a justifying comment. If types are fighting you, the type model is wrong — fix it, don't escape it.
2. **Every database query goes through Prisma.** No raw SQL except inside Postgres functions / migrations.
3. **Every multi-tenant query respects RLS context.** A request handler must set the tenant GUC via parameterised `set_config('app.tenant_id', $1, true)` (and `set_config('app.role', $1, true)`) before any data access. Never use `$executeRawUnsafe` with template-string interpolation for the tenant id. Tests must verify cross-tenant access is blocked. See D-007 and D-021.
4. **Every state transition on the `claim` aggregate writes a `claim_event`.** Never mutate `claim.status` directly without the corresponding event. Helper: `ClaimEventService.record(claimId, eventType, payload)` then derive new state.
5. **Every user-visible error returns a structured error response with a code.** The frontend maps that code to a modal. Never throw raw `Error` objects to the controller — use `ProblemDetails` (RFC 7807-shaped) with our error code namespace.
6. **No browser `alert()`, `confirm()`, `prompt()`, or unstyled toasts for serious errors.** All errors flow through the `<ErrorModal>` system in `apps/web/components/modals/`. Lookup table at `reference/error-codes.md`.
7. **Every external integration call (NHCX, PMJAY, ABDM, TextGuru, Nodemailer, OpenAI) is logged into `integration_message`.** Both request and response. Idempotency keys on outbound. Correlation IDs everywhere.
8. **No PII in logs.** Aadhaar, ABHA ID, policy number, mobile, email — encrypted at rest, redacted in logs. Use the `RedactedLogger` decorator.
9. **No secrets in code or git.** Use the secrets pattern in `apps/api/src/config/`. OVH KMS-encrypted blobs in Postgres for tenant credentials.
10. **No new dependency without justification.** Adding a package requires a one-line entry in the PR description explaining why an existing dependency or stdlib couldn't do it.

## Coding style

- **Functions over classes**, except where NestJS requires classes (controllers, services, modules, pipes, guards, interceptors).
- **Pure domain logic in services; controllers are thin.** Controllers accept input, validate via Zod, call a service, return.
- **One Zod schema per payload, exported from the service module.** Used for both runtime validation and TypeScript types via `z.infer`.
- **Naming**: `camelCase` for variables and functions, `PascalCase` for types/classes/components, `SCREAMING_SNAKE_CASE` for constants, `kebab-case` for filenames in TypeScript code, `PascalCase` for React component filenames.
- **File length budget**: 300 lines for service files, 150 for controllers, 250 for React components. If you exceed it, split.
- **Imports**: absolute imports via tsconfig path aliases. No `../../../`.
- **Async**: `async/await` only. No `.then()` chains except inside one-line transformations.
- **Errors**: throw domain errors from services (`ClaimAlreadySubmittedError`, `PolicyNotFoundError`, etc.) — global filter maps them to ProblemDetails responses with codes.

## Test discipline

- **Unit tests** alongside source files, `*.spec.ts`. Service-level tests for all public methods.
- **Integration tests** in `apps/api/test/`. Real Postgres (test container), real Redis. Mocks only for external HTTP integrations.
- **Contract tests** for every NHCX message type using the demo bundles in `reference/fhir-bundles/`.
- **E2E tests** in `apps/web/__tests__/e2e/` using Playwright (component testing, not browser-automation-of-third-party-portals — that's a different layer).
- Coverage gate: 80% lines, 70% branches. CI fails if coverage drops.

## When you're not sure

1. Re-read the relevant `docs/` file.
2. Search the existing DigiNode reference patterns in `../digi-reference/` (read-only mirror of the existing repo for porting NHCX patterns).
3. Use plan mode to surface what you're about to do before doing it.
4. Ask the user. Underspecified tasks should generate a clarifying question, not a guess.

## Workflow conventions

- **One feature, one branch, one PR.** Branch naming: `feat/<module>-<short-name>`, `fix/<module>-<short-name>`, `chore/<short-name>`.
- **Conventional commits.** `feat(claim): add enhancement submission`, `fix(preauth): correct NHCX header for use-case`.
- **Plan mode for any change spanning more than 3 files.** Show the user the plan first. Implement only after they confirm.
- **Use the TODO tool when** the task has 3+ steps, multiple modules, or non-trivial sequencing.
- **Use skills**:
  - `docx` skill when generating PRD updates, executive summaries, or stakeholder docs.
  - `xlsx` skill when generating payer master, package master, denial taxonomy templates.
  - `pdf` skill when reading EOB samples or producing claim-summary PDFs.
- **Don't use the docx/pptx/pdf skills for routine code documentation.** Markdown is canonical for that.

## What "done" looks like for any task

A task is done when:
1. Code compiles with `tsc --strict` and passes `eslint`.
2. Unit tests pass with coverage above gate.
3. The relevant `docs/` file is updated if behaviour changed.
4. The PR description references the journey or module spec section it implements.
5. New error paths have entries in `reference/error-codes.md` with modal copy.
6. New endpoints appear in the OpenAPI spec generated by NestJS Swagger.
7. The user has reviewed the diff (or in vibe-coding mode, has accepted the plan).

## Things you must never do

- Generate code that mocks the database for integration tests. Use real Postgres.
- Commit migration files without checking they round-trip cleanly (`prisma migrate reset --skip-seed && prisma migrate deploy`).
- Add a new claim status without updating `docs/04-state-machines.md`.
- Add a new error path without updating `reference/error-codes.md`.
- Use `console.log` in committed code. Use the structured logger.
- Hardcode tenant-specific behaviour in shared modules. Tenant differences live in `tenant_config`.
- Touch DigiSparsh's existing code from this repo. The two products are deployed together but evolve independently.
