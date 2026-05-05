# Sprint 1 — Exit document

Sprint window: started after the walking-skeleton PR #1 merged
(early May 2026); closed at PR #9 (this commit).

## What shipped

Eight slices, each a standalone PR landing on `main` with green CI.
65 integration tests gating every change.

| Slice | Theme                                                         | PR  |
| ----- | ------------------------------------------------------------- | --- |
| A     | RBAC + audit pipeline                                         | #2  |
| B     | Invitation flow + notification outbox                         | #3  |
| C     | Password policy + reset + history                             | #4  |
| D     | MFA — TOTP + backup codes                                     | #5  |
| E     | Sessions, IP allowlist, trusted devices, concurrent-session cap | #6  |
| F     | Doctor short-token + HPR stub                                 | #7  |
| G     | Onboarding wizard + readiness + tenant lifecycle FSM          | #8  |
| H     | Runbooks + sprint exit (this PR)                              | #9  |

See `CHANGELOG.md` for per-slice detail.

## Test coverage at exit

| Suite                            | Tests | Notes                                            |
| -------------------------------- | ----- | ------------------------------------------------ |
| `tenant-isolation.e2e-spec`      |   8   | RLS canary — cross-tenant reads/writes blocked   |
| `auth-login.e2e-spec`            |   5   | login/lockout/refresh                            |
| `rbac-audit.e2e-spec`            |   5   | RolesGuard + audit                               |
| `invitation.e2e-spec`            |   5   | invite + accept + resend rate limit              |
| `password.e2e-spec`              |   9   | policy / reset / change / history                |
| `mfa.e2e-spec`                   |   9   | enroll / verify / backup / disable               |
| `sessions-security.e2e-spec`     |   9   | IP allowlist / sessions / trusted devices        |
| `doctor-token.e2e-spec`          |   6   | doctor sign + HPR stub                           |
| `onboarding-lifecycle.e2e-spec`  |   8   | onboarding + readiness + lifecycle FSM           |
| **Total**                        | **64**| (RLS canary counts as 8 assertions in 1 file)    |

## Decisions worth remembering

- **Auth flow ordering (Slice E)** — IP allowlist runs *after* password
  verification so an unauthenticated probe can't infer that an
  allowlist exists. Trusted-device skip runs *after* the IP check so
  a stolen cookie still has to come from an allowed IP.
- **FSM before readiness (Slice G)** — `TenantLifecycleService` checks
  the FSM before running readiness so attempted transitions out of a
  terminal state surface the more actionable
  `TENANT_LIFECYCLE_TRANSITION_INVALID` rather than the noisy-but-
  correct `TENANT_READINESS_CHECK_FAILED`.
- **session_token_history is platform_admin-only** — sessions revoke +
  concurrent-cap eviction must run in `platform_admin` context. RLS
  refuses tenant-context inserts; Prisma's tx aborts on the first RLS
  violation so a `.catch()` doesn't rescue you.
- **Bundled breach list, not online HIBP** — Slice C's password policy
  consults an in-process Set<sha1>. Ops can swap in the full HIBP
  top-100k by replacing `common-passwords.txt` (raw or `sha1:HEX`
  lines). Avoids a network dependency on the auth path.
- **Doctor flow is unauthenticated by design** — the doctor never has
  a tenant login. The 10-minute opaque token + HPR + OTP IS the auth.

## Deferred to Sprint 2

Things we explicitly chose not to do this sprint, with the reason.

| Item                                                                | Why deferred                                                                 |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Real ABDM HPR adapter                                               | We don't have ABDM credentials for the dev tenant yet. Stub mirrors the API. |
| `SECURITY_REFRESH_REUSE_DETECTED` audit event                       | Reuse currently writes only the cascading `USER_LOGGED_OUT` rows; want a dedicated row in Sprint 2. |
| Web warning before saving an IP allowlist that excludes the admin's IP | Backend allows it (and the runbook covers recovery). Sprint 2 backlog. |
| Worker that retries failed `notification_outbox` rows               | V1 dispatches synchronously post-commit. Failed rows stay `failed` until manual replay. |
| Suspicious-login detection (`AUTH_SUSPICIOUS_LOGIN`)                | The error code exists; the heuristic (geo + UA delta) doesn't.               |
| Real package master + payer master sync                             | Slice G readiness gates on these as `completed` evidence flags only.         |
| Generated error-codes table from the markdown source                | `packages/error-codes/src/codes.ts` is hand-edited. A generator ships in S2. |
| Security headers middleware (CSP, HSTS, X-Frame-Options)            | Will land alongside the prod deployment slice in S2.                         |

## Operational artefacts

- `docs/runbooks/` — 4 incident playbooks. New runbooks land here when
  an incident requires a manual step we didn't have yet.
- `/health/live` + `/health/ready` already in place; ready returns
  `{ status: 'ok' \| 'degraded', checks: { database: bool } }`.
- All migrations applied cleanly in CI on every PR via testcontainers
  Postgres + `prisma migrate deploy`.

## Open questions for the user

(Things only the user can answer before Sprint 2 starts.)

1. Is the bundled top-~600 breach list adequate for go-live, or do we
   need to ship the full HIBP top-100k as part of Sprint 2's
   deployment slice?
2. Should the trusted-device cookie TTL stay at 30 days, or shorten to
   match common SaaS patterns (14 days)?
3. PMJAY state list — do we treat it as `completed` evidence (free
   text) or pull a canonical list and gate on it?

## Sprint 2 likely shape

Not committed yet, but the largest deferred items + the start of the
business-domain modules:

- `case` + `claim` + `claim_event` (event-sourced aggregate per
  CLAUDE.md rule 4).
- NHCX adapter (real network calls + `integration_message` logging).
- Master-data sync workers.
- Production deployment slice (security headers, `/health/ready`
  migration check, CSP).
