# 12 — Development Workflow

This doc captures coding standards, branching, testing, CI, and the day-to-day rhythm of building the platform. Follow it not because rules are nice but because consistency lets the team and Claude move fast without breaking things.

---

## Local development setup

### Prerequisites

- Node 20 LTS (use `.nvmrc`: `nvm use`)
- pnpm 9+ (`corepack enable`)
- Docker + Docker Compose
- VS Code with the recommended extensions in `.vscode/extensions.json`

### One-time setup

```bash
git clone <repo>
cd claims-platform
nvm use
pnpm install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env

# bring up postgres + redis + mailhog locally
docker compose -f infra/docker-compose/docker-compose.dev.yml up -d

# initialise DB
pnpm --filter @claims/api prisma migrate dev
pnpm --filter @claims/api db:seed
```

### Daily

```bash
# in one terminal
pnpm dev:api     # NestJS on port 3001 (api mode)
# in another
pnpm dev:worker  # NestJS on port 3001 + 1 (worker mode, same image)
# in another
pnpm dev:web     # Next.js on port 3000
```

VS Code's launch configurations (`launch.json`) let you debug all three with one click.

---

## Branching and PRs

- `main` — production-ready, always green.
- `staging` — what runs in staging; merged from `main`.
- Feature branches: `feat/<module>-<short-description>`, e.g., `feat/preauth-package-suggestions`.
- Fix branches: `fix/<module>-<short-description>`, e.g., `fix/claim-status-rollback`.
- Chore: `chore/<short-description>`.

**One feature, one PR.** Don't bundle. Reviewers can't review what they can't read.

PR template (`.github/PULL_REQUEST_TEMPLATE.md`) requires:
- What this changes (one paragraph)
- Which doc section it implements (link)
- Tests added
- Manual test plan
- Screenshots (for UI changes)
- Migration notes (if any)
- Breaking changes (if any)

PR auto-checks:
- `pnpm lint` passes
- `pnpm test` passes
- Coverage above gate
- Type-check passes
- Error code consistency check passes

PR is merged when:
- All auto-checks green
- One human approval (or two for compliance/security/auth touches)
- The relevant doc has been updated in the same PR

---

## Commit conventions

Conventional Commits, parsed by tooling:

```
feat(preauth):    add package suggestion service
fix(nhcx):        correct callback URL for paymentnotice
chore:            bump prisma to 5.10
docs:             update state machine for new appeal flow
refactor(claim):  extract event recorder
test(settlement): add integration test for short-pay
build:            switch base image to distroless
ci:               add error-codes consistency check
```

Bodies (when needed) explain *why*, not what. Diff explains what.

---

## Code review focus

Reviewers look for:
1. **Correctness** — does it do what the spec says?
2. **Boundary respect** — does it cross module boundaries it shouldn't?
3. **RLS preservation** — does it bypass tenant scoping anywhere?
4. **Error handling** — are domain errors used? Are codes in `reference/error-codes.md`?
5. **Test coverage** — happy path, edge cases, error paths.
6. **Doc updates** — does the relevant `docs/` file reflect the change?
7. **PII handling** — no logs, no responses, no telemetry leaks.

What reviewers explicitly don't worry about:
- Bikeshedding (Prettier handles formatting; lint handles style)
- Personal preference (the spec rules)

---

## Testing strategy

### Unit tests (alongside source, `*.spec.ts`)

- Services: every public method has tests for happy path + at least 2 edge cases.
- State machines: every transition has a test.
- Builders (FHIR templates): test against captured-from-NHCX gold copies in `test/fixtures/`.

### Integration tests (`test/integration/`)

- Real Postgres (testcontainers).
- Real Redis (testcontainers).
- Mocks only for external HTTP (NHCX, BIS, OpenAI, TextGuru, SMTP).
- Cover end-to-end flows: log in, create patient, fetch policy, submit preauth, receive callback, observe state.

### Contract tests (`test/contract/`)

- Use the dummy-payer harness ported from DigiNode.
- Validate every NHCX message type round-trips cleanly.
- These are the tests that catch NHA spec changes.

### Tenant isolation test (`test/integration/tenant-isolation.e2e-spec.ts`)

- Create two tenants, two users.
- User A queries via tenant A context.
- Inject a row from tenant B.
- Assert user A sees zero rows.

This test never weakens.

### E2E tests (`apps/web/__tests__/e2e/`)

- Playwright against a local stack.
- Cover the most-used journeys (J-01, J-04, J-09 from `docs/05-user-journeys.md`).
- Run on every PR.

### Coverage gates

- 80% lines on backend.
- 70% branches on backend.
- 60% lines on frontend (UI is hard; pragmatic).

CI fails if coverage drops below gate.

---

## Linting and formatting

- ESLint with `typescript-eslint`, `eslint-plugin-import`, `eslint-plugin-boundaries` (enforces module dependency rules), `eslint-plugin-react`, `eslint-plugin-jsx-a11y`.
- Prettier with `printWidth: 100`, `singleQuote: true`, `trailingComma: 'all'`.
- Pre-commit (Husky + lint-staged): only changed files are linted.

Custom ESLint rules (in `packages/eslint-config/`):
- No raw SQL outside `database/` or migrations
- No `console.log` in `src/`
- No `any` (use `unknown` then narrow)
- No imports across module boundaries except via service interfaces

---

## CI/CD pipeline

### CI (every push to a branch)

1. Install deps (cached pnpm store)
2. Lint
3. Type-check
4. Run unit + integration tests (Postgres + Redis from compose)
5. Run contract tests (dummy NHCX payer)
6. Run E2E tests (against local stack)
7. Build images (Docker buildx)
8. Run security scans (Trivy on images, Snyk on deps)
9. Validate `reference/error-codes.md` ↔ code consistency

### CD (merge to main → staging)

1. Push images to OVH Container Registry
2. SSH into staging VM, pull, run migrations, restart
3. Run smoke tests against staging
4. Notify Slack/Email

### CD (manual approval → prod)

1. Same as staging but with manual approval gate
2. Pre-deploy: snapshot DB
3. Run migrations (with timeout)
4. Restart with rolling deploy
5. Run smoke tests
6. If smoke tests fail, auto-rollback (image rollback, migration rollback only if reversible)

---

## Migrations

- Generated by `pnpm prisma migrate dev --name <description>`.
- Reviewed in PR — what columns change, what indexes are added, are RLS policies still intact.
- Applied in CI to a fresh DB before integration tests.
- Applied in production via `prisma migrate deploy` only.
- **Never** `prisma db push` against any environment beyond local dev.

For tricky migrations (long-running on prod, lockable, irreversible):
- Add a runbook entry in `infra/runbooks/`
- Schedule with team
- Snapshot DB pre-migration
- Have a rollback plan

---

## Observability in dev

- API logs to stdout in pretty mode locally.
- Redis Commander on port 8081 for queue inspection.
- Mailhog on port 8025 for outgoing email inspection.
- pgAdmin on port 5050 for DB poking.
- All in `docker-compose.dev.yml`.

---

## Performance discipline

- Every endpoint has a budget (default 300 ms p95). If you exceed it, you must justify.
- DB queries on hot paths use `EXPLAIN ANALYZE` to check plans.
- Materialized views for any analytics query that takes >100 ms.
- N+1 queries are forbidden; CI runs `prisma-extension-pulse` (or similar) to detect.
- Frontend bundle budget: 250 KB per route after gzip; CI fails on exceedance.

---

## Security discipline

- No secrets in git. Use `.env.local` (gitignored) or fetch from OVH KMS.
- No hardcoded credentials in tests; use fixtures or testcontainer-generated.
- No `console.log(user)` or similar — always use the redacted logger.
- All endpoints under `/api/v1` require auth except `/health`, `/auth/login`, `/auth/refresh`, `/auth/doctor-otp`.
- Rate limit every endpoint via the global guard.
- Sanitize every Markdown rendering on the frontend (a TPA query response that contains a script tag should never execute).

---

## Documentation discipline

The most important rule: **docs and code are in the same PR.** When code behaviour changes, the doc changes in the same commit. CI checks that the relevant doc section was touched if certain code paths were touched (heuristic, not perfect, but catches the obvious cases).

If a doc says X and the code does Y, the doc is wrong. Fix the doc first (in plan mode), then change code, in one PR.

---

## What "feature complete" means

Before declaring a feature done:
- [ ] Acceptance criteria from the journey/module spec are met
- [ ] Unit + integration tests passing with coverage above gate
- [ ] Tenant isolation test still passes
- [ ] E2E test (if user-facing)
- [ ] Modal copy added to error-map (if new error paths)
- [ ] OpenAPI doc generated cleanly
- [ ] Doc section updated
- [ ] PR description references the spec section
- [ ] Reviewer signed off
- [ ] Smoke test on staging green for ≥24 hours before prod deploy
