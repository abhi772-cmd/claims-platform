# Smoke test — verify the web app end-to-end after Sprint 10

Use this after pulling `main`. Walks through every screen the Sprint 10 PRs touched, with expected behaviour, **and** lists the catches that surfaced during the session so you don't have to discover them yourself.

**Sprint 10 PRs verified by this guide:** #94 (Stage 5 communication outbound), #95 (T3-2 lump-sum), #96 (T3-1 variance dashboard), #97 (T2-15 SLA timers), #98 (T1-5 replay foundation), #100 (eligibility wired), #101 (preauth wired), #102 (claim-submit wired), #103 (communication wired).

---

## 0. Pre-flight (one-time setup after the session's PRs landed)

```bash
cd "C:/Users/abhij/OneDrive/Desktop/HCX VIBE CODING/claims-platform"

# 1. Sync main + install + regenerate prisma client (new column in IntegrationMessage).
git checkout main
git pull origin main
pnpm install
pnpm --filter @claims/api exec prisma generate

# 2. Apply the new migration (adds IntegrationMessage.nextRetryAt + index).
pnpm --filter @claims/api db:migrate:deploy

# 3. RE-RUN SEED. This is the most important step. Two new permissions
#    (communication.send, communication.view) landed in #94. Existing
#    seeded roles in your DB DO NOT have them until you re-seed.
#    Skipping this is the #1 cause of "why am I getting 403 on the
#    Communications panel" later.
pnpm --filter @claims/api db:seed

# 4. Sanity check — typecheck + lint should be clean on a fresh tree.
pnpm -r typecheck
pnpm -r lint
```

Expect each of the four commands to exit 0 with no errors.

---

## 1. Boot the app

Two terminals:

```bash
# Terminal 1 — API on :3001
pnpm --filter @claims/api dev

# Terminal 2 — web on :3000
pnpm --filter @claims/web dev
```

Wait for both to settle (~15s for the API; "Compiled successfully" for web).

### Boot-time signals to look for

Watch the API logs for these:

```
[NhcxReplayWorker] replay handler registered operation=eligibility.verify totalHandlers=1
[NhcxReplayWorker] replay handler registered operation=preauth.submit totalHandlers=2
[NhcxReplayWorker] replay handler registered operation=claim.submit totalHandlers=3
[NhcxReplayWorker] replay handler registered operation=communication.request totalHandlers=4
[NhcxReplayWorker] nhcx replay worker initialised handlers=[...]  (or similar)
```

**All four handlers must register.** If `totalHandlers` ends at 3 or fewer, one of the services failed to bootstrap. Search the API logs for stack traces.

---

## 2. Log in

Browser → http://localhost:3000

```
email:     abhijeet.sharma@digisparsh.in
password:  ChangeMe!Skeleton2026
```

Then accept the "must change password" prompt if it appears. (You'll land on `/dashboard`.)

---

## 3. Walk every changed screen

For each screen below: open it, do the action, confirm the expected signal.

### 3a. `/cases/[id]` — case detail page

The most heavily-touched page. Three new things were added here across Sprint 10:

| What | Where on page | Expected |
|---|---|---|
| SLA pills (T2-15) | Patient hero card, below MRN/admission rows | Two coloured pills appear ONLY after preauth/claim submit. Empty state on a fresh case is correct. |
| Communications panel (#94) | Between the Appeal panel and the bottom timeline | Glass card titled "Communications". Empty state says "No messages yet." |
| Plan preview card (stub) | Above the eligibility action | Renders null in current state — that's the stub from earlier session work. |

**Action: send a communication.**

1. On any open case, type "test message" into the Communications panel textarea
2. Click **Send to payer**
3. Expected:
   - Button shows "Sending…" briefly
   - Message appears in the timeline above as "You sent · HH:MM"
   - Two new rows appear in the **Integration logs** panel (bottom right): outbound `nhcx communication.request` succeeded, inbound succeeded
   - Case **timeline** (bottom left) shows a new `communication.outbound_sent` event

**If you get 403:** you skipped step 0.3 (re-seed). Run `pnpm --filter @claims/api db:seed` and refresh.

### 3b. `/admin/remittance` — lump-sum + CSV batch

Two panels on this page now:

| Panel | What |
|---|---|
| **Lump-sum UTR allocation** (top, new from #95) | The CFO workflow — paste a UTR + total, suggest claims, allocate |
| Remittance batch CSV (bottom, existing) | The Slice AL CSV import flow |

**Action: try lump-sum allocation.**

1. Click **Suggest claims** with no UTR filled
2. Expected: an empty candidates table if you have no claims at `manual_match_pending`; or a table of open settlements if you do
3. Paste a UTR like `TEST-001`, total `100`, pick a claim (if any candidate appears), enter `100.00` in the Allocate column → **Allocate UTR**
4. Expected: green banner "Allocation complete" with Applied count

**Known correctness gotcha:** the duplicate-UTR check is per-tenant. If you re-run with the same `bankTxnId`, you'll get a 422 — that's intentional.

### 3c. `/admin/variance` — CFO variance dashboard

New page from #96. Sidebar entry under **Operations → Variance**.

| Section | Expected |
|---|---|
| KPI tiles (5 across) | All five render with `₹0` numbers if no adjudicated claims exist; populated if you have any with `CLAIM_APPROVED` / `PAYMENT_*` status |
| Aging buckets rail (left) | Empty if no unsettled claims; populated buckets are clickable to filter the drill-down |
| Top payers leaderboard (right) | Empty if no claims; populated otherwise |
| Drill-down table (bottom) | Filters by clicking aging-bucket pills or payer rows |

**Action: just click around.** Confirm nothing 500s.

### 3d. `/cases` — case list

No direct change in #97, but verify SLA pills aren't broken there (they're NOT shown in the list cards — that was intentionally deferred per the #97 PR).

Expected: list cards look the same as before Sprint 10. No SLA pills on list cards. ✅ correct.

### 3e. Communications panel — replay timeline pip

The `queued: true` payload flag landed in #103 but **the UI does not yet render a distinct visual for queued messages**. They'll appear identical to confirmed-sent messages. This is a known UI gap — listed in the "Follow-ups" section below.

---

## 4. Backend signals to verify

Open `psql` or whatever DB client points at `DATABASE_URL`:

### 4a. New permissions seeded

```sql
SELECT permissions
  FROM role
 WHERE name = 'tenant_admin'
   AND tenant_id IS NOT NULL;
```

Expect to see `communication.send` and `communication.view` in the JSON array. If not, re-run seed (step 0.3).

### 4b. Migration applied

```sql
\d integration_message
```

Expect to see `nextRetryAt` column (timestamp, nullable) and an index named `integration_message_status_nextRetryAt_idx`.

### 4c. No queued_for_retry rows in normal operation

```sql
SELECT id, operation, status, "retryCount", "nextRetryAt"
  FROM integration_message
 WHERE status = 'queued_for_retry'
 LIMIT 10;
```

Expect **0 rows** under normal operation (no gateway failures). The presence of rows here is fine — it means the worker has parked something for retry; check the API logs to see if the worker is draining them.

---

## 5. Known issues / follow-ups (not blockers)

1. **Communications panel doesn't visually distinguish `queued: true` entries.** When the replay queue parks a message, the operator sees it as if sent — there's no spinner / pip indicating "gateway hasn't ack'd yet." Add a small amber dot when `entry.payload.queued === true`. Single-file change in `CommunicationsPanel.tsx`.

2. **Variance dashboard empty-state copy is generic.** When a tenant has zero adjudicated claims, the KPI tiles render `₹0` with no explanatory text. Worth adding "No claims yet — variance will populate after first approval" copy.

3. **NHCX sandbox real-mode untested.** Everything in Sprint 10 runs against `NhcxStubAdapter`. Real-sandbox creds aren't in `.env.example`. When the actual NHA sandbox creds land, the JWE adapter path needs end-to-end smoke (eligibility → preauth → claim → payment → communication). The replay queue is wired but hasn't seen a real gateway hiccup.

4. **Discharge service not wired to replay queue separately.** Discharge rides on top of `communication/request` via `buildCommunicationBundle`, so the communication wiring in #103 covers its transient path. Documented in #103's CHANGELOG.

5. **PMJAY task/submit + insurance-plan lookup not wired to replay.** Both are PMJAY-only and lower-frequency. Track if PMJAY rollout pushes their volume up.

6. **List-card SLA pills under `/cases` deferred (#97 follow-up).** `CaseSummary` doesn't carry events; needs list-endpoint change.

7. **CHANGELOG.md needs a Sprint 10 close section** when the sprint actually ships. Currently each slice has its own header under "Sprint 10 — TBD" — wrap them with a short "what shipped" summary once you're ready to call the sprint done.

---

## 6. If something genuinely breaks

| Symptom | Most likely cause | Fix |
|---|---|---|
| `403 Forbidden` on Communications panel | New permissions not in DB | `pnpm --filter @claims/api db:seed` |
| API won't boot, `Cannot find module '@prisma/client/...'` | Prisma client stale | `pnpm --filter @claims/api exec prisma generate` |
| `column nextRetryAt does not exist` | Migration not applied | `pnpm --filter @claims/api db:migrate:deploy` |
| Variance dashboard 500s | Tenant has claims with `payerCode = NULL` | Already handled — they group as `__unassigned__`. If still 500, paste the stack |
| SLA pill never appears on case-detail | Claim has no `preauth.submitted_internally` event yet | Expected — pills only show after preauth submission |
| Lump-sum allocation 422 with "duplicate UTR" | You re-ran with same `bankTxnId` | Use a different `bankTxnId` |

---

## 7. Verification done — what to do next

If all 7 sections above pass:

- You have a stable working web app after the Sprint 10 PRs
- Outbound NHCX integration is now resilient to gateway downtime for 4 of 5 services
- CFO has variance + lump-sum reconciliation
- Hospital floor has IRDAI SLA timers + proactive communication

Next priorities (your call):

| Option | Why |
|---|---|
| Fix the 7 known issues above | Make the existing surface area as polished as possible before adding more |
| **T2-14 room rent sub-limit pre-warn** | Highest user-visible value remaining; patient-trust win |
| **T2-8 ICU upgrade auto-enhancement** | Daily-pain workflow on the ward |
| **Stage 9 `/status/search`** | Ops audit endpoint, small |
| **Real NHCX sandbox integration** | Unblocks moving from stub to real; requires NHA creds |

Recommended: start with **issue #1** (queued-pip in CommunicationsPanel) — it's a 10-minute fix that visibly improves the resilience UX. Then **T2-14**.

---

_Last updated: end of Sprint 10 session (#94–#103 all merged). 7 follow-ups documented._
