# Session handoff — Sprint 10 close

Hand this file to the next Claude Code session by saying:

> Pick up the claims-platform work. Read `SESSION_HANDOFF.md` at the repo root, then `SMOKE_TEST.md`, then the last 10 entries of `CHANGELOG.md`. Goal is "stable working web app."

That, plus the auto-loaded `CLAUDE.md` and the memory files under `~/.claude/projects/.../memory/`, gets a fresh session to ~95% of where the previous one was.

---

## Where things stand right now (snapshot)

- **Date of this snapshot:** 2026-05-16
- **Last commit on `main`:** `1a366df` — feat(communication): wire sendOutbound() to NHCX replay queue [T1-5 follow-up] (#103)
- **Working branch:** `chore/session-handoff` (this file's branch)
- **Local working tree:** clean except for untracked `.claude/`

### Open PRs (verify with `gh pr list --state open`)

| PR | Branch | What |
|---|---|---|
| **#104** | `chore/smoke-test-guide` | Adds `SMOKE_TEST.md` — docs only, no code |
| **#105** | `chore/ci-node24-optin` | Sets `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true` in CI to dodge the 2026-06-02 forced flip — all 3 CI green |
| **this PR** | `chore/session-handoff` | This very file plus a memory-file update |

All three are docs-or-config-only. Risk: zero (104, this PR) or low-with-easy-revert (105).

---

## What this session shipped — 10 merged PRs

| # | Slice | Edge cases | Commit on main |
|---|---|---|---|
| 1 | Stage 5 communication outbound (hospital-initiated `communication/request` + UI panel + inbound mirror) | T2-6, T2-10, T3-3 | `83a5d4f` (#94) |
| 2 | T3-2 lump-sum UTR allocation across multiple claims | T3-2 | `11cbe4b` (#95) |
| 3 | T3-1 CFO variance dashboard (KPIs + aging buckets + by-payer + drill-down) | T3-1 | `0dc804a` (#96) |
| 4 | T2-15 IRDAI SLA timers on case-detail | T2-15 | `db2e0a8` (#97) |
| 5 | T1-5 NHCX outbound replay queue (foundation: schema + worker + service helpers) | T1-5 | `58c16d7` (#98) |
| 6 | Eligibility wired to replay | T1-5 | `033d100` (#100) |
| 7 | Preauth wired to replay | T1-5 | `6695c75` (#101) |
| 8 | Claim-submit wired to replay | T1-5 | `2e0bc6a` (#102) |
| 9 | Communication outbound wired to replay | T1-5 | `1a366df` (#103) |

**Edge cases meaningfully closed:** T1-5, T2-6, T2-10, T2-15, T3-1, T3-2, T3-3 — 7 of the original 31 from `MISSION` brief.

**Outbound NHCX coverage:** all four primary services (eligibility, preauth, claim-submit, communication) now survive gateway downtime via the replay queue. Discharge rides on top of `communication/request` so it's covered transitively. PMJAY `task/submit` + `insuranceplan` deliberately unwired (PMJAY-only, low frequency).

### Note on PR #99

PR #99 was opened then auto-closed by GitHub when its base branch (`feat/nhcx-replay-queue`) was deleted in the squash-merge of #98. The same code came back as **#100**. Lesson recorded in `~/.claude/projects/.../memory/feedback_stacked_pr_auto_close.md`.

---

## What the next session should do FIRST

1. **Run the smoke test.** Open `SMOKE_TEST.md`, follow it top to bottom. This is the real "stable working web app" check.
   ```bash
   git checkout main && git pull
   pnpm install
   pnpm --filter @claims/api exec prisma generate
   pnpm --filter @claims/api db:migrate:deploy
   pnpm --filter @claims/api db:seed       # CRITICAL — new permissions land here
   pnpm -r typecheck && pnpm -r lint
   ```
   Then `pnpm --filter @claims/api dev` and `pnpm --filter @claims/web dev` in two terminals; log in; walk through `/cases/[id]`, `/admin/remittance`, `/admin/variance`.

2. **If anything fails**, fix that first. Don't add new features on top of an unverified base.

3. **Merge any of #104, #105, and this PR (#106 or similar)** — all docs/config, all safe.

---

## What's queued next after smoke test passes

In priority order:

| Pick | Effort | Why |
|---|---|---|
| **Fix the 7 known issues** in `SMOKE_TEST.md` § 5 | small-medium each | Polish what's shipped before adding more |
| **T2-14 room rent sub-limit pre-warn** | medium | Highest user-visible value among remaining edge cases; patient-trust impact |
| **T2-8 ICU upgrade auto-enhancement** | medium | Daily-pain ward workflow; HMIS hook required |
| **T2-13 non-medical auto-strip** | medium | EOB-line processing; visible at discharge |
| **Stage 9 `/status/search`** | small | Ops audit endpoint |
| **Real NHCX sandbox integration** | medium-large | Blocked on NHA credentials; needed for actual production cutover |

My recommendation if the smoke test passes cleanly: start with **issue #1** in SMOKE_TEST.md (queued-pip in CommunicationsPanel) — 10 minute UX fix that visibly improves the resilience story we just built. Then **T2-14**.

---

## Hard rules to remember (auto-loaded from CLAUDE.md but worth repeating)

- TypeScript strict, no `any`, no `@ts-ignore`
- All multi-tenant queries through `runInTenantContext(tenantId, role, cb)`
- Every state transition writes a `claim_event` via `ClaimService.transition()`
- Every external integration call writes to `integration_message` (both directions)
- No PII in logs; encrypted at rest; redacted in structured logger
- ProblemDetails-shaped error responses with codes from `@claims/error-codes`
- No emoji unless explicitly asked; sentence case in UI; teal + amber only

## Session-specific patterns learned (in memory files)

- **`feedback_stacked_pr_auto_close.md`** — never merge with `--delete-branch` while stacked PRs exist on that base; they auto-close
- **`feedback_fhir_ambiguity_policy.md`** — don't stop to ask on FHIR profile choices; mirror existing builders/parsers
- **`feedback_per_pr_changelog.md`** — every slice PR needs a CHANGELOG entry; lapses cause backfill chores
- **`feedback_env_gates.md`** — new required env vars must be production-only or all integration tests fail at boot

---

## Verification commands the next session can run

To confirm this snapshot is still accurate:

```bash
# Real PR state
gh pr list --state open --json number,title,headRefName

# Confirm main is at the expected commit
git log origin/main --oneline -1

# Confirm the 10 Sprint 10 PRs are in history
git log origin/main --oneline --grep="\[T[0-9]\|Slice\|Sprint 10\|hospital-initiated\|variance dashboard\|SLA timers\|replay queue\|lump-sum\|communication/request" --since="2026-05-14" | head -20
```

If those agree with this file, you're caught up. If they disagree, this file is stale — trust git, update this file as part of the catch-up.
