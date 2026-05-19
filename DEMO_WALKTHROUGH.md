# Demo Walkthrough

Step-by-step script for walking a stakeholder through the DigiSparsh Claims Platform using the seeded demo dataset.

## Setup (one-time)

```bash
# 1. Make sure the DB is reachable (Neon by default; see apps/api/.env)
# 2. Run the comprehensive demo seed
pnpm --filter @claims/api db:seed:demo:walkthrough

# 3. Start the services
pnpm dev:api      # NestJS on :3001
pnpm dev:web      # Next.js on :3000

# 4. Open http://localhost:3000
```

Re-running the seed wipes + recreates the demo data idempotently. It does **not** touch your existing `digisparsh-dev` tenant.

## What got seeded

| Tenant | Lifecycle | Rails | Users | Cases |
|---|---|---|---|---|
| Apollo Hospital, Mumbai | **LIVE** | NHCX + PMJAY | 5 | ~60 |
| Narayana Health, Bangalore | **LIVE** | NHCX only | 5 | ~40 |
| AIIMS, Delhi | **LIVE** | PMJAY-heavy | 5 | ~40 |
| Medanta, Gurgaon | **IN_SETUP** (partial) | NHCX | 1 | 0 |
| Manipal, Pune | **IN_SETUP** (fresh) | NHCX | 1 | 0 |
| Fortis, Chennai | **SUSPENDED** | NHCX | 1 | 5 (closed) |

**Password (every demo user):** `Demo@2026`

**Login emails follow the pattern** `<role>@<tenant-slug>.demo`:

| Role | Apollo | Narayana | AIIMS | Inactive tenants |
|---|---|---|---|---|
| Tenant admin | `admin@apollo-mumbai.demo` | `admin@narayana-bangalore.demo` | `admin@aiims-delhi.demo` | `admin@<slug>.demo` |
| Senior operator | `sr_operator@apollo-mumbai.demo` | … | … | — |
| Operator | `operator@apollo-mumbai.demo` | … | … | — |
| Doctor | `doctor@apollo-mumbai.demo` | … | … | — |
| Finance / CFO | `finance@apollo-mumbai.demo` | … | … | — |

---

## Walkthrough — 25-minute version

### Act 1: Login + Dashboard (3 min)

1. Open `http://localhost:3000/login`
2. Sign in as **`admin@apollo-mumbai.demo`** / `Demo@2026`
3. **Talking points on the login page:**
   - Glassmorphism — frosted card, teal radial wash on warm off-white
   - Animated CAPTCHA (hydration-safe — type the displayed code)
   - "Keep me signed in" trusts the workstation
4. Dashboard renders:
   - Hero tile with today's preauth count
   - 4 KPI tiles (claims this week, variance, avg time to preauth, rejection rate)
   - Recent activity table (claims across statuses)
   - Quick actions row (verify coverage, new preauth, record discharge, reconcile payment)

### Act 2: Case List + Filtering (3 min)

1. Click **Cases** in the sidebar
2. Show:
   - 60 cases for Apollo, spread across every status
   - Filter pills — click "Preauth" to narrow
   - Status pills colour-coded (amber for queries, green for approved, red for rejected)
   - SLA pills on rows — some green (in window), some amber (approaching), some red (breached)
3. Density toggle: cards ↔ rows
4. Search by MRN — try `APMH-000001`

### Act 3: Case Detail (NHCX — happy path) (5 min)

1. From the cases list, click a case in **PREAUTH_APPROVED** state
2. Walk down the page:
   - Case header — patient name, MRN, payer, amount, assigned operator
   - SLA pills for preauth + claim windows
   - **Insurance Plan Preview** card
   - Eligibility section
   - **PreauthPanel** — shows the FHIR Bundle that was submitted, includes the "Refresh benefits" CTA (purpose-aware eligibility)
   - **EnhancementPanel** (self-hides for cases that don't qualify)
   - **NonMedicalStripCalculator** — paste a bill, see the auto-strip + medical/non-medical buckets
   - **ClaimPhasePanel** — discharge documents + claim submission
   - **SettlementPanel** — EOB upload + reconciliation
   - **EobLineMatchesPanel** — suggested mapping between payer deductions and bill rows
   - **AppealPanel** (self-hides unless appeal eligible)
   - **CommunicationsPanel** — payer query / response history

### Act 4: PMJAY-first flow on a new case (5 min)

1. Click **+ New case** (amber CTA — the one and only on this screen)
2. Pick rail = **PMJAY** — the **PolicySelector** appears at the top
3. Enter ABHA `14004567891234` (any 14 digits work in stub mode), pick "ABHA"
4. Click **Find policies** — stub returns 1 PMJAY policy
   - Try `STUB-EMPTY-1234567890` (10-digit mobile) → empty-result message
   - Try `STUB-MULTI-1234567890` → 2 policies, pick one
5. Once a policy is picked, payer + policy number auto-fill in the form below
6. Fill patient name, MRN, admission date, consent block
7. Submit — lands on case detail
8. **BiometricGateCard** at the top — operator enters ABHA + payer participant code (`pmjay@hcx`) + ABDM consent token
9. Open capture flow → "Simulate capture (dev)" → verified state
10. PreauthPanel now shows "Refresh benefits" with `purpose=benefits` — explain the three-cycle PMJAY dispatch
11. ClaimPhasePanel shows "Fetch document checklist" with `purpose=auth-requirements`

### Act 5: Variance dashboard (CFO view) (3 min)

1. Sidebar → **Admin → Variance**
2. Show:
   - KPI tiles (total claimed, total settled, variance amount, cases with variance)
   - Variance trend line (12 weeks)
   - Aging buckets (0-7d / 8-14d / 15-30d / 31-60d / 60+d)
   - Drill-down table — variance cases sorted by amount, with reason codes
3. Click any row to drop into the case

### Act 6: Tenant onboarding wizard (multi-hospital) (3 min)

1. Sign out, sign in as `admin@medanta-gurgaon.demo` (mid-onboarding tenant)
2. Show **Admin → Onboarding** — 5 of 9 steps complete, 4 pending
3. Sign out, sign in as `admin@manipal-pune.demo` (fresh tenant)
4. Same page — only step 1 done, 8 pending
5. Sign in as `admin@fortis-chennai.demo` (suspended tenant)
6. Show the suspended-state treatment (most pages locked, lifecycle banner)

### Act 7: Edge cases on the variance dashboard (3 min)

Back on Apollo (`admin@apollo-mumbai.demo`):

- **SHORT_PAID** cases — variance dashboard shows the amount + reason code
- **APPEAL_INITIATED / APPEAL_SUBMITTED** — open one, show the AppealPanel
- **CLAIM_REPROCESS_REQUESTED** — open one, explain the PMJAY CRC flow
- **PREAUTH_CANCELLED** — show the PMJAY-specific cancel reason code with the preserved `initimationNumber` typo (matches the spec)
- **ABANDONED** — case status flipped, hidden from default list

---

## What's intentionally NOT in the demo

- **DLT-registered SMS sends** — templates exist (`reference/dlt-sms-templates.md` if added) but no live SMS goes out; the SMS adapter is stubbed
- **Real NHCX gateway traffic** — `NHCX_MODE=stub` is the default; all integration_message rows are simulated
- **Production OCR** — bill classifier accepts pasted text; the upload-document-to-OCR path is tracked in memory but not implemented
- **Real Aadhaar biometric devices** — the BiometricCapture component has a "Simulate capture (dev)" button that stands in for a real fingerprint scanner SDK
- **Email send capture** — the dev compose file's MailHog catches emails on `localhost:8025`, but you need `pnpm infra:up` first to see them

---

## Resetting between demos

If you want a clean slate before another demo:

```bash
pnpm --filter @claims/api db:seed:demo:walkthrough
```

This wipes all 6 demo tenants and recreates them. Your existing `digisparsh-dev` tenant (created by `pnpm db:seed`) is untouched.

## Troubleshooting

- **Login fails with "Internal server error"** — API isn't running. Restart `pnpm dev:web` and `pnpm dev:api`.
- **Cases list is empty** — wrong tenant. Sign in as the Apollo / Narayana / AIIMS admin, not a Medanta/Manipal/Fortis user.
- **PolicySelector returns no policies for valid ABHA** — stub mode is keyed on identifier prefix. Use `STUB-MULTI-*`, `STUB-EMPTY-*`, or any normal-looking 14-digit ABHA for the single-policy happy path.
- **Variance dashboard is blank** — only Apollo has SHORT_PAID cases. Switch tenants if you logged in elsewhere.
