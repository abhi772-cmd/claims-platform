# Changelog

Notable changes to the DigiSparsh Claims Platform. The format is loosely
[Keep a Changelog](https://keepachangelog.com/) but oriented around
sprint slices rather than calendar releases.

## Sprint 11 — in flight (May 2026)

### Pre-auth document checklist enforcement gate (T1.1)

Converts the per-payer / per-phase document checklist from advisory-only
display into a real submit gate. Pre-auth submit now blocks when any
document the resolved checklist marks `required: true` for the claim's
`(phase=preauth, rail, payer, package, admissionType)` has not been
uploaded — directly attacking the top cause of preauth query/rework
cycles (a mandatory doc the IPD desk didn't know the payer required).

- `PreauthService.submit` now resolves the checklist (`MasterDataService
  .resolveChecklist`) and verifies each required document type has a
  completed + clean/skipped upload (`DocumentService.hasDocumentType`)
  before transitioning. Vacuously satisfied when no rules match, so it
  never surprises a flow that had no rules.
- New error code `PREAUTH_DOCUMENTS_INCOMPLETE` (412) wired through
  `@claims/error-codes` (codes + presentation) and a new
  `PreauthDocumentsIncompleteError` — the `errors.documents` array lists
  the missing `documentType`s. Modal copy already existed in
  `reference/error-codes.md`.
- Web: new `PreauthChecklist` component (rendered in `PreauthPanel`)
  shows required docs with present/missing status and an inline upload
  for missing ones, so the gate is operable in the pre-auth phase. The
  upload pipeline was extracted to a shared `lib/upload.ts`
  (`uploadDocument` + helpers), reused by `ClaimPhasePanel`.
- Integration test `preauth-checklist-gate.e2e-spec.ts`: gate fires
  (412 + missing list), clears on upload, ignores non-required items,
  and is a no-op with no rules.

### Bill OCR — upload a final bill to seed the non-medical classifier (T2-13 follow-up)

Replaces the paste-as-text step in the discharge non-medical classifier
with a real "Upload bill (PDF/image)" path. The operator uploads a
hospital final bill; it's OCR'd into line items that pre-fill the
classifier, and the existing classify / per-line override / save flow
runs unchanged.

- New `bill-ocr` adapter family (`apps/api/src/modules/bill-ocr/`):
  `off` (disabled), `stub` (sentinel fixtures), `real` (HTTP). Mirrors
  the `eob-ocr` pattern but stateless/buffer-only. `BILL_OCR_MODE` env;
  `real` reuses `EOB_OCR_INFERENCE_URL` / `EOB_OCR_API_KEY` (one OCR
  machine, two routes — bill posts to `/extract-bill`).
- New stateless endpoint `POST /discharge/extract-bill` (base64 upload,
  `CLAIM_DRAFT`-gated) → `{ status, engine, lines: [{description,
  amountPaise}], error? }`. No Document row, nothing persisted.
- New contracts `BillOcrExtractRequest/Response` (`bill-ocr.schema.ts`),
  reusing `BillLineSchema`.
- Web: `NonMedicalStripCalculator` gains an upload button that reads the
  file, calls extract-bill, and seeds the textarea; paste stays as the
  fallback for off / low-confidence / failed.
- OCR machine (`eob-ocr-machine`): new `/extract-bill` route + Ollama
  bill-line prompt/schema, reusing the PDF rasterisation layer.

### PMJAY package-driven costing — Phase 1 (D-023)

Starts making PMJAY claims package-driven (the way the scheme actually
works) instead of free-typed amounts. Phase 1 is pure-additive: no FHIR
bundle shape changes, so the locked snapshot/contract tests stay green.

- New `claim_line_item` table (migration
  `20260611000000_claim_line_item_package`) — the costing spine. Each
  `package` line is an HBP package at its fixed rate; `implant`/`addon`
  lines arrive with the Phase 3 multi-line UI. `unitAmount`/`display`
  are snapshotted at add-time. Tenant-scoped via RLS-FORCE, same pattern
  as `bill_line_item`.
- New denormalised `claim.packageCode` (the primary package) and
  `preauth_draft.packageCode` — closes a spec↔code drift: `packageCode`
  was specced on the Claim in `docs/03` from the start but never built.
- Preauth save path: choosing a package snapshots it as the primary
  claim line (sequence 1) and auto-fills `requestedAmount` from the
  package's fixed rate — overridable, not hard-locked, so enhancement /
  implant cases still work. The draft, the line, and `claim.packageCode`
  are written in one tenant transaction.
- Master-data `GET /packages` gains a `q` typeahead over code + name.
- Preauth UI gains an HBP package picker (PMJAY rail only in Phase 1,
  per D-008) that searches packages and auto-fills the amount.
- New contracts: `ClaimLineItem`, `ClaimLineType`, `ClaimLineStatus`,
  `SaveClaimLineItem*`; `packageCode` added to `PreauthDraftSchema`.

Phase 2 (deferred): emit `Claim.item[]` from the line items gated on
`rail === 'pmjay'`, regenerate the reference bundles + snapshots, and
land per-line payer adjudication on the inbound parse path.

### Co-pay floor-vs-cap modelling on payer commercial terms

Fixes a correctness gap in the out-of-pocket co-pay math. Previously,
when a payer had BOTH a percent and a flat co-pay, the estimate took
`max(percent, flat)` — wrong for the dominant Indian MOU phrasing
"10% capped at ₹50,000", which is `min(percent, flat)`. Since this
number is read out to a family before admission, the over-statement
risked eroding trust.

New nullable `copayFlatMode` enum (`'cap' | 'floor'`) on
`payer_commercial_terms` (migration
`20260609000000_payer_terms_copay_flat_mode`, no backfill — existing
rows keep NULL):

* `cap` — "X% capped at ₹Y" → patient pays `min(percent, flat)`
* `floor` — "X%, minimum ₹Y" → patient pays `max(percent, flat)`
* NULL/ignored when only one of the two values is set.

The commercial terms drawer surfaces a "Percent + flat combine as"
selector that appears only when both co-pay fields are filled. The
`computeOop` helper on `/cases/new` branches on the mode (defaulting
to `cap` — the safer/lower assumption — when both are set but the
basis didn't specify). The policy basis (coverage check) always
passes `null` since the eligibility response returns a single co-pay
figure, never both.

### Slice CM — three-method DPDP consent capture (OTP + Emergency + ABHA)

Replaces the free-text acknowledgement-method dropdown on `/cases/new`
with a three-card method picker:

- **ABHA Consent Manager** — visible only when the patient has an
  ABHA ID; surfaced as the recommended option. UI flow ships in a
  follow-up slice (HIE-CM adapter).
- **OTP confirmation** — operator clicks "Send OTP" → backend mints a
  6-digit code, sha256+pepper hashes it (server-side pepper from
  `CONSENT_OTP_HASH_PEPPER`), persists with a 10-minute TTL, and
  dispatches via the existing SMS adapter. Operator types the code
  back; verify flips status. The verified `otpId` is threaded into
  `IntakeConsent.acknowledgementRef`; `ConsentService.grantWithTx`
  validates the (tenant, status='verified', consentType) tuple
  before the consent_record commits. Rate limit: 5 sends per mobile
  per rolling hour. Lockout: 3 failed verify attempts.
- **Emergency / verbal** — two-witness verbal capture for
  unconscious / illiterate / no-mobile patients. Reason code +
  verbal transcript captured; counter-sign workflow + 24h sweeper
  arrive in a follow-up slice. The dropped methods (`signed_paper`,
  `tele_consent_call`) are no longer offered.

Schema additions:
- `consent_record.acknowledgementMethod` (`'otp' | 'verbal_countersigned' | 'abha_hie_cm' | null`)
  + `consent_record.acknowledgementRef` (uuid → per-method artifact).
- New `consent_otp` table — append-only OTP issuance + verification
  artifact, RLS enabled with same-tenant SELECT/INSERT/UPDATE,
  DELETE blocked.
- New `'pending_countersign'` consent status (additive — status is
  TEXT, no enum migration needed).
- New audit events: `CONSENT_OTP_INITIATED`,
  `CONSENT_OTP_VERIFIED`, `CONSENT_OTP_VERIFY_FAILED` (all
  CONSENT retention class).

Migrations:
- `20260609000000_consent_method_otp` — adds columns + consent_otp.
- `20260609000001_consent_otp_mobile_based` — drops the patient FK
  and nulls `consent_otp.patientId` so OTP can be issued during
  intake BEFORE the patient row exists (the case-submit path
  backfills the patientId atomically with the consent_record).

API surface:
- `POST /consents/otp/initiate` → mints + dispatches OTP.
- `POST /consents/otp/verify` → matches code, flips to verified.
- `POST /consents` and the case-create path accept
  `acknowledgementMethod` + `acknowledgementRef`.

Backward compat: `evidence.acknowledgedVia` remains free-text;
existing tests + seed using `'in_person_signature'` continue to
work without migration. The new columns are nullable so legacy
rows land with method/ref both NULL.

Known gaps for follow-up slices: ABHA HIE-CM adapter not wired;
verbal-countersigned status state machine + 24h sweeper not built
(verbal currently lands as `status='granted'` not
`'pending_countersign'`); no hard mobile-vs-OTP-mobile cross-check
at consent-grant time (operator-verified linkage only); SMS dispatch
not logged into `integration_message` (pre-existing gap, unrelated
to this slice).

### Out-of-pocket: policy vs MOU comparison with operator choice

The single out-of-pocket tile becomes a **two-panel comparison** so
the billing desk can see — and choose between — the two bases that
drive a patient's upfront cost:

* **Per patient's policy** — co-pay / deductible / room cap from the
  verified coverage check (`VerifyCoverageByIdentifiersResponse`).
  The patient's policy co-pay always applies (contractual liability).
* **Per payer MOU** — the same fields from the negotiated commercial
  terms; honours `copayAppliesTo` against the admission type.

Each panel shows its own co-pay / deductible / room-shortfall / total.
When both bases carry data they render side by side with a "Use these"
selector; picking one highlights it and feeds that basis's room cap
into `policyRoomRentLimit` so the existing shortfall warning + the
case capture align with the operator's choice. When only one source
has data, that panel renders alone (no choice needed); when neither
does, the section stays hidden. Room rate is shared across both
panels (from the catalog dropdown) — the bases differ only in
co-pay / deductible / cap. A prompt nudges the operator to decide
when the two totals diverge.

### Cases/new room catalog dropdown + out-of-pocket pre-warn

Replaces the free-text "Room daily rate (₹)" input on `/cases/new`
with a dropdown driven by the per-tenant room catalog. When the
operator picks a payer (via Find patient or the rail-specific
selector), the dropdown re-fetches against
`GET /room-categories?payerCode=…` and renders the resolved rate
for each row — `Private room · ₹9,500 (negotiated · default ₹12,000)`
when the payer has an override, the catalog default otherwise.
Falls back to the free-text input when the catalog is empty so
tenants who haven't built one yet aren't blocked.

A new **out-of-pocket tile** in the Room & coverage card combines
co-pay + deductible + room-rent shortfall into one estimate per the
payer's commercial terms. Renders only when terms exist for the
selected payer; honours `copayAppliesTo` (skips the co-pay
component for emergencies when the MOU says "planned only"); shows
each component (co-pay / deductible / shortfall) with its own hint
("max of 10% or ₹5,000", "per admission", "₹3,500/day × 5 days").
Drives the "tell the family BEFORE admission" workflow we already
had for room-rent shortfalls — now with the negotiated commercial
context layered in.

### Room catalog admin page (`/admin/room-categories`)

CRUD surface for the tenant's room catalog. Table lists every
category (active + inactive) with code / name / category /
default rate / sort order / status. Modal form for create + edit;
soft-delete (active=false) preserves historical case captures.

The page is reached either via the sidebar (if added later) or
from the `/admin/onboarding/payer-commercial-terms` page's
`Manage catalog →` link.

### Demo seed — commercial terms slice

`seed-demo-data.ts` extended with four room categories
(General ward / Semi-private / Private / ICU at ₹5k / ₹8k / ₹12k / ₹25k)
plus payer rate overrides for STAR_HEALTH and HDFC_ERGO on the
higher-tier categories, plus full commercial terms for both
payers (co-pay %, deductible, TAT, payment term, discount,
network category, empanelled specialties). All upserts so the
seed remains idempotent.

### Payer commercial terms admin UI

The form half of the previous slice. New page at
`/admin/onboarding/payer-commercial-terms` lists every active payer
with a fully-complete / incomplete badge and a sub-status for
"room rates filled / total" and "mandatory terms set". Clicking a
row opens a slide-over drawer with three tabs:

* **Tariff (required)** — room rate matrix (one row per active room
  category showing the catalog default + an input for the payer-
  negotiated rate; blank = "use default") plus co-pay (% or flat,
  with `appliesTo` picker) and deductible (amount + scope).
* **Operations & settlement** — preauth/claim TAT, prior-intimation
  rules, payment term, payment mode, bank ref, TDS, interest on
  delayed, dispute escalation window, flat/pharmacy discount %,
  implant pass-through, sub-limits (room/ICU/nursing per-day,
  consultation/ambulance per-claim).
* **Coverage & compliance** — pre-existing waiting, maternity (+
  waiting), day-care, modern treatments, network category, notice
  period, NABH/NABL flags, auto-renews, empanelled specialties
  (comma-separated → Postgres `String[]`), free-text notes.

Save runs two passes: room rate upserts via
`RoomCategoryApi.upsertPayerRate` (and deletes for cleared cells),
then a single `PayerCommercialTermsApi.upsert`. The two halves are
independent — if rates persist but terms fail (or vice-versa),
nothing is rolled back; the page refresh picks up whichever side
succeeded so the operator can retry the other.

Bottom CTA `Mark step complete` activates only when
`status.allPayersComplete === true` from the
`GET /admin/payer-commercial-terms/status` aggregate. Clicking it
posts to the existing `/tenant/onboarding/steps/payer_commercial_terms/complete`
endpoint.

Onboarding wizard at `/admin/onboarding` gets a new
"Configure → Open payer commercial terms" link inside the expanded
step row (wired via a new `INTERNAL_STEP_ROUTES` map for steps
that grow dedicated admin surfaces).

### Per-payer commercial terms catalog (room rates + co-pay + deductible) at onboarding

The structured half of an MOU — what every hospital ↔ TPA agreement
contains, captured as a form (no PDF, no OCR, no AI). Mandatory for
LIVE-state transition so every cashless intake can quote the correct
out-of-pocket before admission. Optional fields (TAT, sub-limits,
payment terms, network category) live behind the same form for admins
to fill as they have the data; the completeness check only enforces
the three mandatory inputs.

Three new tenant-scoped tables, RLS-FORCE:

* `room_category` — the hospital's room catalog with default cash
  rates. Code is upper-snake (`GENERAL_WARD`, `ICU`); name and
  category are free text so admins can use whatever vocabulary fits
  the hospital. Rates in paise.
* `room_category_payer_rate` — per-payer overrides on top of the
  catalog. Cascade-deletes with its parent category. `payerCode`
  is the stable `Payer.code` (string, no FK — matches the codebase
  convention used by Claim, IntegrationMessage, etc.).
* `payer_commercial_terms` — one row per (tenantId, payerCode) with
  the structured MOU shape: co-pay (% or flat), deductible (with
  scope: per-admission / per-claim / per-year), effective dates,
  TAT overrides, sub-limits, discount %, payment terms, TDS,
  network category, NABH/NABL flags, empanelled specialties
  (Postgres `String[]`). `paymentMode` is a four-value enum
  (`rtgs | neft | cheque | mixed`) renamed to `BankPaymentMode`
  in contracts to avoid colliding with settlement.schema's
  claim-route `PaymentMode`.

New onboarding step `payer_commercial_terms` slotted between
`payer_master` and `package_master`, `blocksNhcxCutover: true`.
ReadinessService gates `PILOT` and `LIVE` transitions two ways: the
step-flag check (admin marked it complete) AND a data check that
every active payer has a terms row with the mandatory three filled
plus one `room_category_payer_rate` row per active room category.
Belt and braces — admins sometimes flip step flags prematurely.

New API:

* `GET /room-categories?payerCode=…` (`case.create`) — intake-facing
  list with effective-rate resolution per row.
* `GET/POST/PATCH/DELETE /admin/room-categories(/:id)`
  (`tenant.onboarding.update`) — admin CRUD on the catalog.
* `GET/PUT/DELETE /admin/room-categories/:id/payer-rates(/:payerCode)`
  (`tenant.onboarding.update`) — per-payer rate overrides.
* `GET/PUT/DELETE /admin/payer-commercial-terms(/:payerCode)`
  (`tenant.onboarding.update`) — terms upsert by `(tenantId,
  payerCode)`.
* `GET /admin/payer-commercial-terms/status`
  (`tenant.onboarding.update`) — aggregate per-payer completeness
  status used by the onboarding step page.

Soft-delete semantics on `RoomCategory` (set `active = false`) so
historical case captures preserve audit context. The payer rate
captured on the case is the **resolved** rate at intake time —
catalog edits never mutate historical cases (forward-only).

### Claim assignment — owners + "Mine" filter for multi-operator teams

Tier 2 #6 from the operator UX audit. Claims have an
`assignedToUserId` column (it's been on the Claim model since
sprint 7, with a `(tenantId, assignedToUserId, status)` index)
but no UI to set or filter on it. Multi-operator billing-desk
teams had no way to divide the queue. This slice wires the
existing column end-to-end.

No schema migration — the column was already there.

Backend:

* `ClaimService.assign({ tenantId, claimId, userId, actorUserId })`
  — direct UPDATE on `claim.assignedToUserId` (null clears).
  Writes a `claim.assigned` claim_event with payload
  `{ previousAssignedToUserId, newAssignedToUserId }` so the
  audit trail captures who was the owner at each step (and the
  re-assignment history) even after later changes.
* Idempotent — re-confirming the same assignee short-circuits
  without polluting the event log.
* New `claim.assigned` event type added to `ClaimEventTypeSchema`.
  Non-transitioning (resultingStatus = currentStatus) like the
  Stage 5 communication events.
* `POST /cases/:c/claims/:cl/assign` gated on `case.assign`
  (existing permission, already in the seed).
* `GET /cases` accepts a new `assignedTo` query param (uuid)
  that filters via `claims: { some: { assignedToUserId } }`.
  Composes with the existing status / phase / sla / appeals /
  dischargeDue filters.
* `ClaimSchema` and `CaseSummarySchema` extended with
  `assignedToUserId`. Case-detail responses populate per-claim;
  list responses populate from the headline claim.

Web:

* New `<AssigneeWidget>` on case detail — pill next to the
  status pill showing initials + name when assigned, or
  "Unassigned" otherwise. Click opens an inline searchable
  picker over `TenantUsersApi.list` (lazy-loaded on first
  click). Active users only; explicit "Unassign" affordance
  when an assignment exists. Success toast on every change.
* Permission UX: dropdown is shown to everyone — the server
  returns 403 for callers without `case.assign` and the error
  modal surfaces it. Matches the rest of the app's pattern; a
  proper client-side permission gate is a separate slice.
* `<CasesListPage>` gains a "Mine" filter chip in the Quick
  row. On enable, fetches `/me` once, passes the user's id as
  `assignedTo` on every list request. Composable with all
  other filters. URL deep-link via `?mine=true`.
* Both the URL and the active-filter-count helpers updated to
  include `mine`.

Verified: all 6 workspace projects typecheck clean; web lint
clean.



### Audit log — row expansion with full payload + actor names

Tier 2 #5 from the operator UX audit. The audit log table had
the columns reviewers needed (time / actor / action / resource /
correlation) but **no way to see the actual before/after
payload** without DB access. The "Actor" column showed
`user:1234abcd…` — the bare userId prefix — so reviewers
couldn't tell who did what at a glance.

Both pieces of data were already on the wire — the audit
endpoint returns `before`, `after`, `ipAddress`, `userAgent`
fields per row. The web layer just wasn't rendering them.

Web changes (`/admin/audit`):

* **Click-to-expand rows.** Each row gets a chevron in a new
  leading column; clicking anywhere on the row toggles the
  expansion drawer. Only one row open at a time so the table
  height stays stable.
* **Expansion drawer** contains:
  * Full ISO timestamp (vs. the collapsed locale time)
  * Full resource id (vs. the truncated 8-char prefix)
  * Resolved actor name + email, with the `actorType` (user /
    system / scheduled) as a sub-label
  * Correlation id, full
  * IP address + user-agent strings on a metadata strip
  * Before / after JSON snapshots pretty-printed in a two-column
    diff-style layout (single-column when only one side present)
  * Italic "No before / after snapshot captured" fallback when
    both are null
* **Actor name resolution.** Page mount fetches
  `TenantUsersApi.list()` once and builds a Map<userId, user>.
  Each row's `actorUserId` resolves to "First Last" + email in
  both the collapsed and expanded views. Silent fallback to
  the prior id-prefix display if the user-list call fails
  (e.g. operator lacks `user.invite` permission).
* Expanded state collapses on page change so navigation doesn't
  leave a stale drawer open.

Compliance impact:

* DPDP §10 audit-trail review can now be done in-app — no DB
  query needed to see "what changed and by whom" for any
  recorded action.
* The before/after snapshots are already PII-redacted by the
  service before persistence, so the new render path is safe.

Verified: web typecheck + lint clean.



### Operator-action feedback — success toasts on every workflow step

Fresh audit pass after the Tier 1 clean-sweep found a dominant
rough edge: most operator actions completed silently. The
panels reloaded their data, the status pill flipped under the
operator's fingers, but there was no positive "your action
landed" feedback. The operator was forced to look for state
change to confirm a click went through.

This slice wires success toasts into every operator action
handler. Toast infra was already in place from PR #121; the gap
was systematic — none of the workflow-progress actions used it.

Patterns unified:

* **`action()` helper pattern** (SettlementPanel, ClaimPhasePanel,
  AppealPanel previously) — extended the helper to accept an
  optional `successToast` string parameter that fires before
  `onChanged()`. Each call site now passes a domain-specific
  message.
* **Custom handler pattern** (PreauthPanel, EnhancementPanel,
  CommunicationsPanel, case-detail eligibility) — added
  `useToast()` import and inline `showToast()` at the success
  path of each handler.

Action ↔ toast wiring:

* **Eligibility** — verified → `"Coverage verified: <plan>"`;
  failed → warning toast with the payer's failure reason.
* **Pre-auth** — save draft → `"Pre-auth draft saved"`;
  submit → `"Pre-auth submitted to payer — IRDAI 1-hour timer started"`.
* **Enhancement** — start → `"Enhancement drafting started"`;
  submit → `"Enhancement submitted to payer"`.
* **Discharge** — initiate → `"Discharge initiated — upload supporting documents below"`;
  submit → `"Discharge bundle submitted to payer"`.
* **Claim** — start drafting → `"Claim drafting started"`;
  submit → `"Claim submitted to payer — IRDAI 3-hour timer started"`.
* **Settlement** — expect → `"Payment expected — settlement row created"`;
  receipt → `"Receipt recorded against settlement"`;
  reconcile → `"Settlement reconciled"`;
  close → `"Settlement closed"`.
* **Communications** — send → `"Message sent to payer"`.

(Pre-existing toasts on write-off, appeal-resolve, breach-notify,
consent-withdraw, dialog confirms — left untouched.)

Three workflow toasts deliberately name the IRDAI SLA timer
("1-hour" / "3-hour") so the operator immediately knows the
clock has started. The eligibility-failed toast surfaces the
payer's reason text directly so the operator doesn't have to
hunt for it.

Verified: web typecheck + lint clean.



### PlanPreviewCard — real insurance-plan summary on case detail

Closes Tier 1 #1 from the operator UX audit. Before this slice,
`apps/web/components/insurance-plan/PlanPreviewCard.tsx` was a
literal `return null` stub with the comment *"Stub placeholder
so the dev build compiles."* The case-detail page imported and
rendered it, so the slot where the insurance plan summary should
appear was **always blank**.

This is the third Tier 1 gap to close in this Sprint and
**clean-sweeps Tier 1**.

Pragmatic scope decision: rather than blocking on a full FHIR
`Coverage.benefit[]` parser (deductible + co-pay extraction —
gateway-specific quirks, fragile), this slice composes the card
from data we already have:

* `eligibility.verified` ClaimEvent payload → `planName`,
  `sumInsured`
* Case row (T2-14 columns) → `policyRoomRentLimit`
* Claim row → `approvedAmount` (sum-to-date)

A richer FHIR parser drops in later without breaking the
contract.

Backend:

* New `InsurancePlanModule` + `InsurancePlanService.getForClaim()`
  reads the three sources in parallel inside one tenant-scoped
  tx. Returns `InsurancePlanResponse` keyed on a 3-state
  `EligibilityVerificationStatus` enum (`not_run | verified |
  failed`).
* `GET /cases/:c/claims/:cl/insurance-plan` gated on
  `case.view`. Tenant-owned by the existing
  `CaseService.assertOwns` pattern.
* No persistence — the response is a read-side projection.

Contract (`InsurancePlanResponse`):

* `status`, `planName`, `sumInsured` (gateway's number,
  RUPEES not paise — matches what the eligibility event
  carries), `policyRoomRentLimitPaise`, `approvedToDatePaise`,
  `verifiedAt`, `failureReason`.

Web:

* `<PlanPreviewCard>` is now a real component. Three states:
  * **not_run** — muted hint pointing at the eligibility action
    on the case-detail page.
  * **failed** — amber banner with the verification failure
    reason from the eligibility event.
  * **verified** — full happy path: status pill with the verify
    timestamp, plan name, four mini-stat tiles
    (Plan / Sum insured / Room rent cap / Approved to date),
    and a coverage-hint bar showing sum-insured usage % +
    headroom (tones from primary → amber at 60% → red at 90%).
* The card now renders content under every claim status — case
  detail no longer has a blank slot.

Deliberately deferred:

* Full FHIR `Coverage.benefit[]` extraction (deductible, co-pay,
  per-procedure sub-limits). The `<MiniStat>` grid is sized to
  drop those in as new tiles without restructuring.
* Persisted `InsurancePlan` cache. The current read path is
  cheap enough (3 parallel reads) that pre-computation isn't
  yet worth the staleness risk.

Verified: all 6 workspace projects typecheck clean; web lint
clean.



### Cases list — search + claim-phase filters + URL deep-links

Closes Tier 1 #4 from the operator UX audit. The cases list had
four broad chips (`all / open / closed / abandoned`) and no
search at all. Operators couldn't filter by claim phase, by SLA
state, by appeal state, or by patient name. The operational
dashboard tiles (PR #124) all linked to `/cases` with no filter,
so even with the new tiles a billing manager couldn't drill in.

Backend (`GET /cases`):

* New query params, each independently composable:
  * `q` — free-text search across `patientName`, `hospitalMrn`,
    and headline claim's `preauthRefNum` / `claimRefNum`. Case-
    insensitive `contains` via Prisma.
  * `phase` — claim phase bucket
    (`drafting | awaitingPayer | approved | paymentPending`).
    Status sets defined inline; mirror the dashboard tile
    bucketing one-to-one so a tile click takes the operator to
    the same set of cases the tile counts.
  * `sla` — `breached | at_risk | any`. Server-side post-load
    filter because SLA state is computed from the event stream
    at read time and can't be expressed as a Prisma where-clause.
  * `appeals` — boolean. Filters to claims in
    `APPEAL_INITIATED` / `APPEAL_SUBMITTED`.
  * `dischargeDue` — boolean. Cases where
    `admissionDate + estimatedStayDays` falls within today ± 1
    day AND the claim is in the approved-but-not-discharged
    window.
* `CaseService.list()` builds the Prisma where clause for
  server-filterable bits (status, phase, appeals, search,
  dischargeDue prefilter), then runs SLA + dischargeDue
  post-filters in TS. When post-filters apply, the DB pulls a
  larger candidate page (up to 500) and we slice the operator-
  facing page after filtering — the alternative was undercounts.

Web (`/cases`):

* Search input at the top, debounced 300 ms — typing doesn't
  fire a request on every keystroke. Inline "searching…" hint
  while the debounce is in flight.
* Three chip rows organised by axis:
  * **Status** (`All / Open / Closed / Abandoned`).
  * **Phase** (`Any phase / Drafting / Awaiting payer / Approved
    / Payment pending`).
  * **Quick** (SLA pill with cycle-through state, Discharges-due
    toggle, In-appeal toggle).
* All filter state syncs to URL params via `router.replace`
  (scroll: false). Deep-links from the dashboard tiles work;
  browser back/forward works; bookmarkable views work.
* Active-filter counter + "Clear all" link in the header row
  when any non-default filter is set.
* Empty state diverges: when filters are active, copy reads
  "No cases match the filters" + "Clear all filters" CTA;
  when no filters, the original "Nothing here yet" + "Create
  new case" CTA.

Dashboard tile hrefs updated:

* Open claims → `/cases?status=open`
* SLA at risk → `/cases?status=open&sla=breached` if any
  breached, else `/cases?status=open&sla=any`
* Discharges due → `/cases?status=open&dischargeDue=true`
* Pending appeals → `/cases?status=open&appeals=true`

Verified: all 6 workspace projects typecheck + web lint clean.



### Dashboard — operational tiles for daily operators

Before this slice, the dashboard landing page had four stat tiles
— **all compliance/security**: Open breaches · Overdue
(breaches) · Active consents · Unbound access (24h). A billing
manager opening the dashboard saw nothing about *their* work.

This slice adds a "Today's work" row of operational tiles above
the existing compliance bento. Compliance row stays — different
audience, both useful.

Backend:

* New `GET /dashboard/operational` endpoint gated on `case.view`
  (the broadest operator permission).
* `DashboardService.operational(tenantId)` — single Prisma pass
  over open claims (loading their events so we can compute IRDAI
  SLA at-risk in the same scan). The SLA logic reuses
  `computeSlaForClaim` from the existing T2-15 implementation;
  no duplication.
* `DashboardModule` registered in `app.module.ts`.

Response shape (`OperationalDashboardResponse`):

* `openClaims.{total, drafting, awaitingPayer, approved,
  paymentPending}` — phase bucketing of every open claim. Each
  bucket maps to a defined set of `ClaimStatus` values
  (e.g. `drafting` = `ELIGIBILITY_*` + `*_DRAFTING` +
  `DISCHARGE_PENDING`).
* `slaAtRisk.{breached, expiringSoon}` — sum across both preauth
  and claim phases. A claim breached on both phases tallies as
  2 because each is independent regulatory exposure.
* `dischargesDueToday` — open cases whose `admissionDate +
  estimatedStayDays` lands within today ± 1 day AND whose
  headline claim is in the approved-but-not-discharged window.
  Computed in TS because Prisma can't express the column-
  arithmetic filter cleanly.
* `pendingAppeals` — claims in `APPEAL_INITIATED` /
  `APPEAL_SUBMITTED`.

Web:

* New "Today's work" section on `/dashboard` with four
  operational tiles:
  * **Open claims** — total with `drafting · awaiting payer`
    sub-text
  * **SLA at risk** — sum of breached + expiring soon; tone
    flips to red when any are breached
  * **Discharges due** — count within today ± 1 day
  * **Pending appeals** — active + submitted
* Each tile clicks through to `/cases`. Per-filter deep links
  (e.g. `?slaAtRisk=true`) are deferred to the cases-list
  search slice (Tier 1 #4).
* Tiles render `—` while loading and silently degrade to `—`
  if the API call fails — never blocks the rest of the
  dashboard from rendering.
* React Query handles the fetch with retry: false (same pattern
  as the existing compliance query).

Verified: web + api + contracts typecheck clean across all 6
workspace projects; web lint clean.



### Discharge — real document upload, replacing the stub flow

Before this slice, the `<ClaimPhasePanel>` upload form was a
filename text input + a `/documents/upload-stub` POST that
created a metadata row with `sizeBytes: 1024` and no actual file
binary. Operators typed `discharge_summary.pdf`, a fake row
landed in the DB, and the downstream discharge / claim-submit
bundle referenced documents that didn't exist in storage.

**This was the biggest gap in the operator UX** — every claim
shipped with fake document references.

The real two-step upload pipeline already existed on the API
(`POST /documents/upload-init` → presigned PUT URL → `POST
/documents/:id/finalize`), it just wasn't wired to the web. This
slice connects them.

Web — new upload flow in `<ClaimPhasePanel>`:

1. Operator picks a real file via `<input type="file">`. Selected
   filename + size render inline.
2. On Upload click, the browser:
   * Reads the file as ArrayBuffer.
   * Computes `crypto.subtle.digest('SHA-256', buffer)` for the
     finalize-time content hash.
   * Calls `uploadInit` with `{ documentType, originalFilename,
     contentType, sizeBytes }`. Server creates a 'pending'
     Document row and returns `{ uploadUrl, expiresAt,
     requiredHeaders }`.
   * If `uploadUrl` starts with `stub://` (dev `STORAGE_MODE=stub`):
     skip the PUT, base64-encode the bytes (cap 5 MB matching
     `UploadFinalizeRequestSchema.scanBufferBase64`), pass to
     finalize so the in-process scanner can run.
   * Else: PUT the file bytes to `uploadUrl` with
     `requiredHeaders`. Throws on non-2xx.
   * Calls `uploadFinalize` with `contentSha256` (and
     `scanBufferBase64` in stub mode). Server HEADs the object
     (real mode) or scans the buffer (stub mode); row flips to
     'completed'.
3. Document list refreshes; success toast confirms the upload.

Document rows in the list are now clickable — operator clicks
the filename, browser fetches a short-lived presigned GET URL
via `getDocumentDownloadUrl`, and opens it in a new tab.
Stub-mode rows show an info toast ("Stub storage mode — no real
bytes to download in dev") rather than failing silently.

Client-side limits surfaced before the server has to reject:

* 50 MB upload cap (matches `UploadInitRequestSchema`).
* Inline red error text when the picked file exceeds the cap.
* The 5 MB stub-scan-buffer limit silently skips the in-process
  scan rather than erroring — that's a dev-mode-only path.

What this doesn't change:

* The legacy `/documents/upload-stub` endpoint stays. Integration
  tests still use it and dev/stub mode can still invoke it.
* `documentLifecycle.worker` still expires stale 'pending' rows
  past their TTL (the cleanup path that catches abandoned
  uploads — unchanged).
* The discharge / claim-submit bundle builders are unchanged —
  they were already wiring document references through; the
  references just now point at real bytes.

Verified: web typecheck + lint clean. Local Prisma generate still
blocked by Windows OneDrive file lock (carried over from earlier
in the day) — CI runner is unaffected.



### Admin polish round 2 — confirms on destructive actions, success toasts

Audit-grepped the rest of the app for destructive / serious
actions that didn't go through the new ConfirmDialog +
PromptDialog infrastructure shipped in PR #121. Found four
high-value targets:

**SettlementPanel — Write off.** TERMINAL FINANCIAL ACTION
("we'll never collect ₹X"). The old UX was an inline text field
+ a one-click red button — too easy to fat-finger past the point
of no return. Replaced with a single "Write off settlement…"
button that opens a multiline PromptDialog (min 10 chars,
mandatory reason captured in audit log). Followed by a success
toast confirming the write-off landed.

**AppealPanel — Resolve appeal.** Records the payer's BINDING
decision (approved / partially_approved / rejected) with the
money amount. Now opens a ConfirmDialog summarising the outcome
about to be recorded — including the amount — with a tone keyed
to the decision (danger for rejection, warning otherwise). Once
recorded the claim moves to a terminal appeal state, which the
dialog spells out. Followed by a success toast. Start-appeal and
submit-appeal also gained success toasts.

**me/sessions — Revoke session** + **me/trusted-devices — Remove
trust.** Both were one-click destructive without confirmation.
The session revoke can sign somebody out of an active workflow;
the device-trust removal forces full MFA on next sign-in. Both
now use ConfirmDialog with a warning tone and copy that names
the affected device (user-agent). Both emit a success toast.

Success-toast follow-throughs:

* Compliance: notify-DPB and dismiss-incident actions now show
  a confirming toast.
* Consents: withdraw action now shows a confirming toast.

These complete the action → feedback loop the dialog
infrastructure was missing. Reviewer clicks Confirm, the API
call lands, and the toast confirms it landed — no more
"did that actually go through?" silence.

Verified: web typecheck + lint clean.



### Admin polish — replace browser alert / confirm / prompt with styled dialogs

CLAUDE.md rule #6 is explicit: "No browser `alert()`, `confirm()`,
`prompt()`, or unstyled toasts for serious errors." Audit found
four lingering violations in the admin pages:

* `compliance/page.tsx` — `window.alert()` for scan-complete
  toast, `window.confirm()` for "Notify the Data Protection
  Board" (a DPDP §8(6) regulatory action), `window.prompt()` for
  breach dismissal reason.
* `consents/page.tsx` — `window.prompt()` for consent
  withdrawal reason (DPDP §6 data-subject rights flow).

These were the last unstyled flows on serious actions. This slice
replaces them with reusable promise-based dialogs + a styled
toast system.

New infrastructure:

* `<ConfirmDialogProvider>` + `useConfirm()` + `usePrompt()`
  hooks. Promise-based — caller awaits the user's decision.
  ConfirmDialog supports three tones (primary / warning /
  danger) keyed to icon + button styling; PromptDialog supports
  single-line or multiline input, min/max length validation,
  inline character counter, ESC-to-cancel, click-outside-to-
  cancel. Modeled on the existing `<ErrorModalProvider>` pattern.
* `<ToastProvider>` + `useToast()` hook for transient success /
  info / warning messages. Bottom-right stack, auto-dismiss
  after 4s, FIFO eviction past 4 visible. Replaces the one
  remaining `alert()` for success messaging.
* Both providers mounted in the root `app/layout.tsx` between
  `ErrorModalProvider` and the page tree so every page can use
  them.

Wired into:

* Compliance dashboard — scan-complete success now toasts;
  notify-DPB and dismiss-incident use the new dialogs with rich
  copy (DPDP §8(6) context, audit-trail implications, examples).
* Consents viewer — withdrawal prompt uses the multiline
  PromptDialog with DPDP §6 context.

Why this matters beyond aesthetics:

* `window.confirm()` for a regulatory notification is unsafe —
  there's no context, no proper Cancel emphasis, no place to
  surface the audit-trail implications. The styled ConfirmDialog
  carries copy explaining what the action will record.
* `window.prompt()` blocks the entire page, doesn't validate
  inline, can't show min-length progress, and renders poorly on
  mobile. The styled PromptDialog has a live character counter
  that turns green when the threshold is met.



### Admin /users — real directory replacing the "coming soon" stub

The `/admin/users` page used to be a one-line placeholder
("User directory — coming soon") with an Invite CTA. This slice
replaces the stub with a real tenant-user directory.

Backend:

* New `GET /tenant/users` endpoint on the existing user-admin
  controller. Gated on `user.invite` permission — anyone who can
  invite a teammate can see who already exists.
* `UserService.listForTenant(tenantId)` reads every user in the
  current tenant, hydrates roles + last-login + invite expiry,
  and orders by status (invited first) then createdAt desc so
  admins see pending invitations + newest hires at the top.
* New `TenantUserSummary` + `ListTenantUsersResponse` schemas in
  `@claims/contracts`. `inviteExpiresAt` is non-null only for
  `status='invited'` rows so the UI knows when to render the
  expiry hint.

Web:

* Rebuilt admin/users page — search box, status filter chips,
  table with avatar/name/email/designation, role chips, status
  pill + invite-expiry countdown + MFA badge, last-sign-in,
  inline "Resend invite" button on invited rows.
* Status chips show counts; "Suspended" and "Deactivated" chips
  hide when there are zero in that bucket (don't promote
  unused affordances).
* Invite-expiry text turns red when expired so admins can spot
  invitations the recipient missed.
* Empty states for two cases: no users at all (first-time
  tenant) and no users matching the current filter.

Wire client:

* `apps/web/lib/api/tenant-users.api.ts` — list + resendInvite.

Verified: web typecheck + lint clean; contracts typecheck clean.



### EOB-line matcher (Phase 3) — multi-line subset matches

Phase 2 (#118) handled one payer deduction → one bill row. Real
payer EOBs aggregate: "non_payable_items: ₹2,500" maps to FIVE
hospital rows (toiletry, tv-rental, attendant-food, comfort,
admin-fees) that sum to ₹2,500. Phase 3 fans out across subsets.

Pure matcher:

* Bounded subset-sum search — for each deduction, the matcher
  evaluates BOTH the best single-line candidate AND the best
  subset (size ≥ 2) of category-aligned bill rows whose sum
  lands within tolerance of the deduction amount. Higher score
  wins; ties resolve toward single-line (the simpler explanation).
* New signals `subset_sum_exact` + `subset_sum_close`, slotted
  into the existing confidence ladder:
  * subset_sum_exact + category_alignment → high
  * subset_sum_exact alone → medium
  * subset_sum_close + category → medium
  * subset_sum_close alone → low
* Search is depth-capped (MAX_SUBSET_DEPTH = 6) with ascending-
  sort pruning; typical bills are 5-30 rows and search completes
  in microseconds.
* Subset matches honour category filtering: a `non_payable_items`
  deduction only considers non-medical rows. `cap_exceeded` and
  similar non-aligned categories let all rows compete.
* Dispute-candidate semantics for subsets: flagged when ANY
  subset member is hospital-medical. Reviewer sees one banner
  for the deduction even if only one of N rows is the disputed
  one.
* 7 new spec cases on top of Phase 2's 17 → 24/24 passing.

Schema:

* New `eob_line_match_item` join table — id, tenantId,
  eobLineMatchId, billLineItemId. One row per ADDITIONAL subset
  member; the primary stays on `eob_line_match.billLineItemId`
  for back-compat. Unique on (eobLineMatchId, billLineItemId);
  cascades on either parent's delete. RLS-FORCEd.

Service / API:

* `EobLineMatcherService.confirm()` now accepts
  `additionalBillLineItemIds[]` and writes join rows alongside
  the primary in one tenant tx. Re-confirmation deletes-then-
  inserts (existing cascade handles the join rows).
* `suggestForClaim()` includes join rows via Prisma relation;
  the pure matcher replays confirmed subsets with their full
  member set.
* `EobLineMatch` response shape gains
  `additionalBillLineItemIds[]`, `additionalBillLineDescriptions[]`,
  `additionalBillLineAmountsPaise[]`, `subsetSumPaise`.
* `ConfirmEobLineMatchRequest` accepts the optional
  `additionalBillLineItemIds` array (capped at 20).

Web:

* `<EobLineMatchesPanel>` row now renders subset members as
  removable chips below the primary picker, with a "+ Add
  another bill line to this subset" dropdown for grow-on-demand
  reviewer adjustment. A live subset-sum readout shows running
  total vs deduction amount in green when they match.
* Confirm button label flips to "Confirm subset" when the row
  has additional members.
* New `subset sum · N lines` / `subset ~close · N lines` signal
  chips.
* `<AppealPanel>` `formatDisputeCandidates()` extended: a
  multi-line dispute renders the deduction header followed by
  indented sub-bullets per subset member, so the auto-drafted
  appeal grounds spell out exactly which bill rows are in scope.

Deliberately deferred:

* No bulk confirm — each deduction still confirms one at a
  time. Bulk would invite reviewer rubber-stamping; force
  per-row attention.
* No "swap primary with additional" UI — to change the primary,
  reviewer removes the current additional, picks a different
  primary from the dropdown, then re-adds the old primary as an
  additional. Low-frequency enough to not warrant a special
  affordance.
* Subset search depth is fixed at 6. Phase 4 (if needed) could
  lift this when payer files show category strips touching more
  rows.



### EOB-line matcher (Phase 2) — confirm, fuzzy amount, appeal hook

Phase 1 (#117) shipped read-only suggestions. Phase 2 closes the
remaining loops:

1. **Persisted reviewer confirmations** — a new `eob_line_match`
   table stores the operator's chosen mapping for each payer
   deduction. Confirmed rows survive reload and override the
   auto-suggest on subsequent matcher runs. Natural key
   `(claimId, deductionIndex)`; one confirmation per deduction.
   `billLineItemId` is nullable — the reviewer can record an
   explicit "no bill line matches this deduction" finding, and
   the auto-suggester respects it.
2. **Fuzzy amount tolerance** — new `amount_close` signal fires
   when bill and deduction amounts agree within ±1% (capped at
   ±₹100). Catches the common case of payer rounding without
   accepting noisy multi-rupee gaps as matches. Tuned so a
   ₹50,000 surgery does NOT match a ₹50,500 deduction (real
   disagreement) but a ₹500 toiletry kit DOES match a ₹495
   deduction (rounding).
3. **Appeal-drafting hook** — on claim-rejected / short-paid
   statuses, the AppealPanel surfaces a "Pull N confirmed
   disputes" button that pre-populates the appeal-reason
   textarea with a formatted block of every confirmed dispute
   candidate. The reviewer can edit afterwards; this just gives
   them a non-empty starting draft.

Schema:

* New `eob_line_match` table — id, tenantId, claimId,
  deductionIndex, billLineItemId (nullable), isDispute (captured
  AT CONFIRM TIME — does NOT drift with later bill-row flips),
  confirmedAt, confirmedById. Unique index on
  (tenantId, claimId, deductionIndex). RLS-FORCEd, cascades on
  claim delete AND on bill_line_item delete.

Service / API:

* `EobLineMatcherService.confirm(input)` — upsert semantics:
  delete-then-insert inside a tenant tx; audit_log row carries
  the confirmed (deductionIndex, billLineItemId, isDispute).
* `EobLineMatcherService.reset(input)` — idempotent delete of
  one confirmation; audit row only written when something was
  actually removed.
* `EobLineMatcherService.suggestForClaim()` — now parallel-loads
  matchers AND confirmations, hands both to the pure matcher,
  which short-circuits the auto-suggest for any deduction with a
  confirmation.
* `POST /cases/:c/claims/:cl/eob-line-matches/confirm` and
  `DELETE /cases/:c/claims/:cl/eob-line-matches/:deductionIndex`
  endpoints; both gated on `claim.draft`.

Pure matcher:

* New `amount_close` factor + `isAmountClose()` helper; bucket
  rules updated (amount_close + tokens → medium; amount_close
  alone → low; amount_exact still beats amount_close on score).
* `ConfirmedEobLineMatch[]` input to `matchEobLines()` —
  confirmations bypass the heuristic loop entirely; the row is
  emitted at `high` confidence with empty `signals[]`. Reviewer's
  word stands on its own without the heuristic chips.
* 7 new spec cases on top of the original 10: amount_close
  basic, ±₹100 cap, amount_exact-beats-amount_close tie-break,
  confirmation-replaces-auto-suggest, confirm-no-match,
  dispute-captured-at-confirm-time, confirmedById surfaced.
  17/17 pass.

Web:

* `<EobLineMatchesPanel>` — each row now exposes a bill-line
  `<select>` (defaults to auto-suggest, lists every bill line
  on the claim plus an explicit "no match" option), a "Mark as
  dispute candidate" checkbox, and a Confirm button. Confirmed
  rows render with a green tint, a "confirmed at HH:MM" badge,
  and a Reset link. New `amount_close` signal chip added.
* `<AppealPanel>` — loads matcher data on claim-rejected /
  short-paid statuses. When ≥1 confirmed dispute candidate
  exists, an amber "Pull N confirmed disputes" CTA shows above
  the reason textarea and inserts a formatted dispute-grounds
  block.

Deliberately deferred:

* No multi-line matches (one deduction spanning several bill
  rows; common with prorated category strips). Phase 3 if
  reviewer-demand emerges.
* No fuzzy token alignment — Jaccard with a stop-word filter is
  still the only text signal.
* No bulk confirm (e.g. "accept all auto-suggestions"); each
  row confirms individually so the reviewer is forced to think.



### EOB-line matcher (Phase 1) — suggest payer-deduction ↔ bill-line mapping

The hospital classifies bill rows at discharge (PR #115). The
payer EOB carries deductions explaining what they didn't pay.
Until now these two views never touched: reviewers eyeballed the
EOB, eyeballed the bill, and reconciled by hand. Phase 1 of the
matcher closes that loop with a read-side suggestion service.

Pure logic:

* `apps/api/src/modules/eob-line-matcher/match-eob-lines.ts` — a
  pure function over three independent signals:
  * **amount_exact** — `BillLineItem.amountPaise === DeductionLine.amount`
    (strongest signal; payer EOBs typically deduct the exact line
    value when stripping a specific item).
  * **token_overlap** — Jaccard similarity on description tokens
    vs `(deduction.category + reason)` tokens. Stop-word list
    drops generic noise like `the`, `for`, `rent`, `gst`. Jaccard
    ≥ 0.34 with amount_exact → high; ≥ 0.5 alone → medium;
    ≥ 0.2 → low.
  * **category_alignment** — payer category `non_payable_items`
    (or `non_admissible`, `exclusion`) ↔ bill `medical: false`.
    Used to break ties and to bump confidence when the hospital
    already agreed with the strip.
* 10-case unit spec covering: empty inputs, amount-exact +
  tokens (high), amount-exact alone (medium), token-only fallback
  (low), dispute-candidate detection, unmatched bill lines,
  totals accounting, and same-bill-line picked twice.

Service / API:

* `EobLineMatcherService.suggestForClaim(tenantId, claimId)` —
  parallel-loads `Settlement.deductions` + bill_line_item rows,
  invokes the pure matcher, returns the suggestion bundle. No
  writes — Phase 1 is observability only.
* `GET /cases/:c/claims/:cl/eob-line-matches` — gated on
  `claim.draft` (same as bill-line-item read/save).
* Response carries per-match `confidence`, `signals[]`, and an
  `isDisputeCandidate` flag (true when the payer deducted a row
  the hospital had tagged medical → appeal candidate).

Web:

* `EobLineMatchesPanel` on case-detail, rendered after the
  SettlementPanel. Self-hides when the claim isn't adjudicated
  or there are no deductions to compare. Surfaces:
  * Per-row: payer category + reason, matched bill description,
    confidence badge, signal chips (amount/tokens/category),
    dispute-candidate flag.
  * Header tally: `matched ₹X / ₹Y` and a `N dispute candidates`
    pill when the payer stripped hospital-medical lines.
  * Footer: count of bill lines NOT picked by any deduction
    ("typically the medical items the payer accepted in full").

Deliberately out of scope (Phase 2 territory):

* No reviewer-confirm / reviewer-reject UI. Suggestions don't
  persist — every page load runs the matcher fresh.
* No multi-line matches (one deduction spanning several bill
  rows, common with prorated category strips).
* No fuzzy amount tolerance (±1% of bill value for rounding
  discrepancies). Phase 1 only matches paise-exact.
* No appeal-draft pre-population from dispute candidates. The
  flag exists; using it lives in the appeal-drafting slice.

Verified:

* 10/10 unit tests pass; `pnpm -r typecheck` + `pnpm -r lint`
  clean across all 6 workspace projects.



### T2-13 follow-up — per-line operator overrides on bill classifier

PR #115 gave the classified bill a durable home but locked the
operator into the classifier's opinion: if "TV rental" came back
as `comfort` and the operator wanted to file it as
`miscellaneous`, they had to edit the description text and rely
on the classifier matching a different term. This slice fixes
that by making every row in the bill table independently editable.

Web:

* `<NonMedicalStripCalculator>` table rows now carry inline
  controls:
  * A medical / non-medical segmented toggle.
  * A category dropdown (shown only when non-medical) with all
    nine categories from `NonMedicalCategorySchema`.
  * A "manual" badge with a reset link when the operator's
    choice differs from what the classifier opined.
* Headline tiles (medical total / non-medical / grand / suggested
  final) and the by-category breakdown are now driven by an
  `effectiveLines` projection — overrides flow immediately into
  the summary math without a refetch.
* Save payload uses the same `effectiveLines` so the persisted
  rows reflect the operator's final word, not the classifier's
  draft opinion.
* On mount-load and on successful save the persisted rows are
  replayed into the overrides map. This way operator decisions
  survive page reload AND any post-save server-side scrubbing
  (medical rows getting category/matchedTerm forced to null) is
  visible immediately in the local UI.

What this doesn't change:

* No schema, no migration — the `bill_line_item` table already
  stored `medical` + `category` as operator-final fields. Only
  the UI surfaces this affordance now.
* The classifier still runs on every textarea edit; it's just
  the seed, not the final word.
* No per-row description / amount editing — the textarea is
  still the way to change those (re-typing is short enough that
  inline edit isn't worth the UX complexity).

Verified:

* `pnpm -r typecheck` + `pnpm --filter @claims/web lint` clean
  across all 6 workspace projects.



### T2-13 follow-up — bill line item persistence

Yesterday's PR #113 shipped an operator-aid bill classifier with no
persistence — the operator pasted the bill into a textarea every
time. This PR gives the classified bill a durable home so:

* the operator can come back later without re-typing
* the EOB-line matcher (separate slice) can map our lines to payer
  deductions when the EOB lands
* the audit trail captures what the hospital actually classified
  at discharge

Schema:

* New `bill_line_item` table — id, tenantId, claimId, description,
  amountPaise, medical (boolean), category (nullable, scrubbed for
  medical rows), matchedTerm (nullable), createdAt, createdById.
  Indexed on (tenantId, claimId). RLS-FORCEd with the same tenant-id
  pattern as `consent_record`. Cascades on Claim delete.

Service / API:

* `POST /cases/:c/claims/:cl/bill-line-items` — replace-all save.
  Deletes the claim's existing rows and inserts the new set in one
  tenant tx. Audit-log row carries lineCount + grandTotalPaise +
  nonMedicalPaise so the trail is bounded but reconstructable.
* `GET /cases/:c/claims/:cl/bill-line-items` — returns lines +
  server-computed totals (medical / non-medical / grand).
* `BillLineItemService` with 6-case unit spec: replace-all
  semantics, empty-set clears, medical-row scrubbing of category +
  matchedTerm, audit snapshot shape, list empty-state, round-trip.
* Permission reuses `claim.draft` — no new permission.

Web:

* `<NonMedicalStripCalculator>` now takes optional `caseId + claimId`
  props. When set:
  * On mount, GETs existing lines and pre-populates the textarea
    from `description\tamount` rows.
  * Adds a "Save to claim" button that POSTs the current classified
    set (replace-all).
  * Shows a "saved N lines at HH:MM" indicator after save.
  * When the props are absent (the component's standalone use)
    the original PR #113 operator-aid behaviour is unchanged.
* Case-detail page passes both props so persistence is enabled on
  every claim opened.

What this doesn't do (intentionally):

* No per-line override UI yet (operator re-types if they disagree
  with the classifier). The persisted `medical` column is honest
  about being operator-override-capable; the UI to wire that lands
  later if needed.
* No `claim_event` for bill save — the `audit_log` row is enough
  for V1.
* No EOB-line matcher (separate slice). The persistence here is
  the data the matcher will consume when it lands.

Verified end-to-end:

* 6-line sample saved to claim → POST 200, 6 rows in Postgres with
  correct totals (medical ₹53,000 / non-medical ₹1,550 / grand ₹54,550)
* Per-line tags preserved through the round-trip (Surgery + Room rent
  medical; Toiletry kit → toiletries; TV rental → comfort)
* Page reload pre-populates the textarea with all 6 lines and shows
  the "saved 6 lines at 02:24" indicator — no re-typing
* `pnpm -r typecheck` + `pnpm -r lint` clean; 6/6 service unit tests pass



### T2-8 — ICU upgrade auto-enhancement (ward tier tracker)

When a patient is moved to a higher-tier ward mid-stay (most
commonly: ward → ICU) the original preauth amount is no longer
sufficient and the hospital needs to submit an enhancement
preauth before discharge. T2-8 closes the gap between "patient
deteriorates" and "claim ready to submit" by giving the operator:

1. A **ward tier tracker** on case-detail that records the current
   room daily rate (PATCH /cases/:id with `currentRoomDailyRate`)
   and shows an amber **auto-suggest banner** when the current
   rate exceeds the admission-time rate. The banner surfaces the
   per-day differential and the projected delta over the planned
   stay, then points the operator at the enhancement panel below.

2. A **preauth enhancement panel** (driving the existing
   ENHANCEMENT_DRAFTING → ENHANCEMENT_QUEUED → ENHANCEMENT_SUBMITTED
   state machine — already defined in claim.state-machine.ts since
   sprint 7, just no service backing it). Five visible phases keyed
   off the claim status: eligible-to-start, drafting form, awaiting
   payer decision, terminal approved, terminal rejected. The
   revised-amount input pre-fills with priorPreauthAmount + the
   suggested top-up so the operator's default is one click away.

Implementation:

- **Migration `20260603000000_case_current_room_rate`** — additive
  nullable `currentRoomDailyRate INTEGER` column on `case` (paise).
  Operator-updated, NULL = not tracked.
- **Contracts:**
  - `UpdateCaseRequestSchema` adds `currentRoomDailyRate` (capped
    at ₹100k/day, nullable so the operator can clear it).
  - `CaseSummary` always returns it.
  - New `enhancement.schema.ts` with start/submit request +
    response shapes.
- **NHCX adapter:**
  - `NhcxAdapter.submitEnhancement(input)` — at the wire level this
    is a `preauth/submit` referencing the prior `preauthRefNum`.
  - Stub adapter echoes the input back as a flat object.
  - JWE adapter explicitly throws "not implemented in real mode
    yet" — the full FHIR enhancement bundle lands when we have an
    NHA sandbox to validate against.
- **EnhancementService + Controller:** start() flips into
  ENHANCEMENT_DRAFTING via the existing state machine;
  submit({revisedAmount, reason}) flips to ENHANCEMENT_QUEUED,
  writes the integration_message ledger, calls the adapter, on
  ack flips to ENHANCEMENT_SUBMITTED. Service guards against the
  missing `preauthRefNum` precondition with a clear 422. New
  module registered in app.module.
- **Case PATCH** now forwards `currentRoomDailyRate`; `case.service`
  audit-logs the before/after value so the ward-transfer history
  is reconstructable from `audit_log`.
- **Web:**
  - `<WardTrackerCard>` inline on case-detail (above the existing
    T2-14 room-rent banner). Always renders when admission room
    rate is captured; switches to amber upgrade-detected styling
    when current > admission.
  - `<EnhancementPanel>` placed between PreauthPanel and the
    NonMedicalStripCalculator. Five-state component;
    self-hides when claim status doesn't qualify.
  - `EnhancementApi` client wrapping the two endpoints.

Permission reuses `preauth.submit` — enhancement IS a preauth
follow-up at the wire level. No new permission needed.

Verified end-to-end:
- WardTrackerCard renders the empty-state ("current not yet
  recorded") on the T2-14 Verify case (which has roomDailyRate
  ₹8000 captured).
- Operator records ₹15000 current rate → PATCH persists →
  re-render shows the amber upgrade banner with
  "Admission ₹8000/day · current ₹15000/day · +₹7000/day differential
  ≈ +₹35000 over 5 days".
- POST /enhancement/start on a claim at INITIATED correctly
  returns 422 VALIDATION_FAILED (state machine guard fires).
- EnhancementPanel correctly hides on non-qualifying statuses
  (the smoke test case is at INITIATED).

Edge case enabled: **T2-8**. Recommended next step is to walk a
case all the way to PREAUTH_APPROVED + observe the panel's
happy-path interaction; the wiring is mechanical so this is
verification rather than discovery.

What this doesn't do (intentionally):
- No HMIS webhook — the design call for an external HMIS auto-detect
  layer is deferred to a real HMIS conversation. The operator
  drives currentRoomDailyRate updates manually for now.
- No real-mode FHIR enhancement bundle — JWE adapter throws
  "not implemented yet" until an NHA sandbox is available.



### T2-13 — non-medical auto-strip bill classifier

Indian health policies routinely exclude a long list of non-medical
items from cashless reimbursement: toiletries, attendant meals,
registration fees, transport, TV / phone / newspaper rentals, etc.
When the hospital submits a claim that includes them, the payer
strips them on the EOB and the family finds out at discharge. T2-13
catches the strip BEFORE the claim is submitted so the operator
can either exclude the items from `finalAmount` or get explicit
acceptance from the family for the differential.

Operator-aid only — pure utility, no schema, no persistence. The
operator pastes the hospital bill (one line per row, tab- or
comma-separated description and rupee amount) into the new
`<NonMedicalStripCalculator>` on the case-detail page (above
ClaimPhasePanel); the component POSTs to a new stateless endpoint
and renders per-line tagging, totals, and by-category breakdown.

Implementation:
- `packages/contracts/src/non-medical-classifier.schema.ts` —
  `BillLine`, `ClassifyNonMedicalRequest/Response`, 9-category enum
- `apps/api/src/modules/discharge/non-medical-classifier.ts` —
  pure-function classifier over a comprehensive Indian-hospital
  keyword catalog (~55 rules across 9 categories, sourced from
  the IRDAI list + cross-payer signals already detected by the
  EOB extractors)
- 44-case unit spec — every catalog rule + false-positive guards
  ("Medical registration number — Dr. Sharma" must stay medical)
  + totals math + by-category aggregation
- `apps/api/src/modules/discharge/non-medical-classifier.controller.ts`
  — POST /discharge/classify-non-medical, gated on claim.draft,
  stateless (no DB, no tenant data), bundled into the existing
  DischargeModule
- `apps/web/components/discharge/NonMedicalStripCalculator.tsx`
  — debounced classify-on-edit, 4 summary tiles (medical /
  non-medical / grand total / suggested final), by-category
  breakdown card, per-line table with matched-term transparency
- `apps/web/lib/api/discharge.api.ts` — thin client wrapper
- Placed on `apps/web/app/(dashboard)/cases/[id]/page.tsx`
  immediately above `<ClaimPhasePanel>` so the operator sees the
  strip math right before they enter the final claim amount

Edge case enabled: **T2-13**. Highest discharge-time UX win
remaining; takes the second-biggest source of surprise-deduction
out of the family conversation.



### Stage 9 — cross-claim NHCX status search ops endpoint

New ops-only endpoint:
```
GET /admin/nhcx/status-search
  ?correlationId=X
  [&claimRefNum=Y]
  [&preauthRefNum=Z]
```

Used when an operator gets a phone call from a payer with a
correlation ID (or a payer ref number) and needs to know what's
on our side — was the request sent, did the inbound arrive, what
state is the claim in. The per-claim integration-messages endpoint
already exists; this one is the missing capability of *finding*
the claim from a correlation when you don't know which case the
ID belongs to.

Strictly read-only and tenant-scoped (RLS enforces). Returns
three slices:

- `integrationMessages` — every outbound/inbound row that matches
- `claimEvents` — every ClaimEvent that carries the matching
  correlationId
- `claims` — distinct claims touched by the above, with current
  status + ref nums so the operator can decide whether to drive a
  manual transition or wait

Implementation:
- New `nhcx.status.search` permission, seeded onto `tenant_admin`
  and `platform_admin` only (intentionally not the ordinary
  operator roles — they don't triage gateway-level mysteries)
- New `NhcxStatusSearchService` in `modules/integration/` with
  9-case unit spec covering the schema refinement, the candidate-
  short-circuit when ref-num matches no claim, the local-only
  state case (claim exists, no gateway traffic), and the
  correlation-AND-refnum intersection
- New `NhcxStatusSearchController` at `/admin/nhcx` registered
  in the existing `IntegrationModule`
- Contract schema in `@claims/contracts/nhcx-status-search.schema`

No NHCX gateway call — this is a local audit lookup over what
we've already recorded. Future slice can layer a real-mode
`/status/search` round-trip on top.



### T2-14 follow-up — list-card shortfall pill

Surfaces the room-rent pre-warn at the triage level too. `/cases`
list cards now render a compact amber `bed +₹X/day` pill next to
the headline claim status whenever the case has both `roomDailyRate`
and `policyRoomRentLimit` captured AND the rate exceeds the cap.
Click-through still goes to case-detail, which has the full banner.

Same wire-up pattern as the SLA pills in PR #109 — `CaseSummary`
already returns the two fields (they were added in PR #110), so
this is a UI-only change. New `RoomRentShortfallPill` component
inlined on the cases page mirrors the case-detail math (one
`Math.max(0, rate - cap)` line) so the two surfaces never disagree.

Operators triaging the case list can now see at a glance which
admissions have a captured shortfall, without opening every case.



### T2-14 — room rent sub-limit pre-warn

First edge case closed in Sprint 11. The single biggest source of
post-discharge surprise bills for Indian patients is the room-rent
sub-limit: policies cap "room rent" per day (typically ₹3000-₹5000),
and when the patient is admitted to a room above the cap, the policy
applies a proportionate deduction on associated services on top of
the per-day room-rent differential. By the time the family hears the
number it's at discharge, and the trust hit is real. T2-14 catches
it at admission.

Three new nullable Int (paise) columns on `case` captured at intake:
- `roomDailyRate` — actual daily rate of the assigned room
- `policyRoomRentLimit` — policy's per-day room rent cap
- `estimatedStayDays` — planned length of stay (optional projection)

Wire-up:
- New `apps/api/src/modules/case/room-rent-liability.ts` pure helper
  (`computeRoomRentLiability`) plus 7-case unit spec covering the
  full branch matrix: missing rate, missing limit, at cap, below
  cap (no underflow), above cap with stayDays, above cap without
  stayDays, policy-cap-is-zero edge.
- `CreateCaseRequestSchema` accepts the three optional paise fields
  with sanity caps (₹100k/day max, 365 days max).
- `CaseSummarySchema` always returns them (nullable) so the
  case-detail page can compute liability without a separate fetch.
- `case.controller.ts` forwards the fields from the validated body
  to `CaseService.create`.
- `case.service.ts` persists when provided; `toSummary` + `assemble`
  type signatures extended to carry the new columns through.
- `apps/web/app/(dashboard)/cases/new/page.tsx` gets a new
  "Room & coverage" glass card with three rupee inputs and a
  live pre-warn block that materialises only when both rate +
  limit are typed: amber "Room rate exceeds cap by ₹X/day"
  with projected total when stay days present, OR a green
  "within the policy cap" confirmation when at/below.
- `apps/web/app/(dashboard)/cases/[id]/page.tsx` shows the same
  warning as a persistent amber banner at the top of the case
  detail when per-day liability > 0.

No effect on cases where the operator skips the fields (emergency
intake, self-pay, partial info) — the banner just doesn't render.
The math mirrors the server-side helper so the two surfaces never
disagree.

Edge case enabled: **T2-14**. Highest user-visible value among the
remaining MISSION-brief edge cases per the Sprint 10 handoff.



## Sprint 10 — closed (May 2026)

**What shipped this sprint.** Sprint 10 was the resilience-and-finish
sprint after the platform's first end-to-end NHCX walkthrough. Headline
themes:

- **Outbound NHCX resilience (T1-5).** The four primary outbound
  services — eligibility, preauth, claim submit, and communications —
  now park transient gateway failures on an in-process replay queue
  and re-issue once the gateway recovers. Operators no longer see hard
  errors for blips in NHCX availability. Foundation + four service
  opt-ins shipped as PRs #98, #100, #101, #102, #103.
- **CFO + finance views (T3-1, T3-2).** Variance dashboard with KPI
  tiles, aging buckets, top-payer leakage, and a filterable drill-down
  (#96). Lump-sum UTR allocation lets the CFO split a single bank
  deposit across multiple settlements without losing the audit trail
  (#95).
- **Operator-floor UX (T2-15, Stage 5).** IRDAI SLA timers on the
  case-detail patient hero (#97); list-card SLA pills follow-up below.
  Stage 5 hospital-initiated communications panel that mirrors inbound
  payer messages and writes both directions to the integration log
  (#94).
- **Smoke-test polish (this batch).** Three SMOKE_TEST.md §5 follow-ups
  bundled here — queued-pip on the communications timeline, variance
  empty-state copy, and the list-card SLA pills (CaseSummary now
  carries `sla`). Plus #107's AbortError modal fix and PII KMS
  onboarding clarity, and #108's auto-refresh-after-send wiring.

Remaining edge cases meaningfully closed this sprint: T1-5, T2-6,
T2-10, T2-15, T3-1, T3-2, T3-3 — seven of the original 31 from the
MISSION brief.

What's NOT in Sprint 10 (carried to Sprint 11):
- T2-14 room-rent sub-limit pre-warn
- T2-8 ICU upgrade auto-enhancement
- T2-13 non-medical auto-strip
- Stage 9 `/status/search`
- Real NHCX sandbox integration (blocked on NHA credentials)

---

### Smoke-test polish — queued pip, variance empty-state, list-card SLA pills

Three SMOKE_TEST.md §5 follow-ups bundled into one PR (this one).

- **Queued pip on outbound communications.** When the replay queue
  parks an outbound `communication/request` (transient gateway
  failure), the operator now sees an amber "Queued" pill + amber dot
  on the timeline row instead of an identical-to-confirmed-sent
  entry. Surfaced by adding `queued: boolean` to `CommunicationEntry`
  in `@claims/contracts` and propagating from the existing
  `payload.queued` flag on the ClaimEvent.
- **Variance dashboard empty-state.** When the tenant has zero
  adjudicated claims, the page used to render five ₹0 KPI tiles with
  no context — easy to read as a broken integration. A small amber
  banner above the tiles now reassures that the numbers are accurate
  and points at what populates them.
- **List-card SLA pills.** `/cases` list cards now show compact
  pre-auth + claim SLA pills next to the headline claim status. The
  list endpoint precomputes `sla` on each `CaseSummary` using the
  same `computeSlaForClaim()` already used by the case-detail page;
  the schema marks `sla` optional so closed/abandoned cases and
  pre-submit cases wire-skip cleanly.

No new schema migration. No behaviour changes outside these three
surfaces. Typecheck + lint clean.



### Smoke-test follow-up — Communications panel auto-refresh

Third polish item from the SMOKE_TEST.md walk. After sending a
proactive communication the case timeline + integration logs
panels stayed at their pre-send state until the operator hit a
manual reload. The data was correct on the server — the rows
just weren't fetched.

CommunicationsPanel now accepts an `onChanged: () => void` prop
(the same shape PreauthPanel / ClaimPhasePanel / SettlementPanel /
AppealPanel already used) and calls it after a successful send,
right after the local communications list refreshes. The case
page passes `() => void reload()`, which re-fetches the case
detail + claim events + integration messages in a single round
trip — same code path the four other panels already use.

Single visible change for the operator: the new
`communication.outbound_sent` event and the two
`nhcx communication.request` rows (outbound + inbound) appear
in the bottom-row timeline + integration-logs panels
immediately, without a refresh.



### Smoke-test follow-ups — AbortError modal + PII KMS onboarding

Two polish items surfaced while walking `SMOKE_TEST.md` against a
fresh clone of `main`. Both are zero-behaviour-change fixes for
developer / operator UX.

- **AbortError mis-classified as INTERNAL_ERROR modal.**
  `ErrorModalProvider.showApiError` treated any non-`ApiError`
  thrown value as `INTERNAL_ERROR`. React StrictMode's dev-mode
  double-fetch race aborts the first request, which surfaced as
  a full-screen "Something went wrong / Reference: INTERNAL_ERROR"
  modal on every page load. Same code path fires on legitimate
  component-unmount and in-flight navigation aborts in prod too.
  Now swallowed early — real `ApiError`s (e.g. `VALIDATION_FAILED`)
  still surface with their correct codes.

- **PII_KMS_ROOT_KEY_BASE64 onboarding gap.**
  First-time devs hit a confusing 500 on case-create because
  `.env.example` didn't mention the key and the runtime error
  blamed the config loader. Per the dev-tolerant-boot design
  documented in `configuration.ts`, the schema deliberately
  doesn't require the key in non-prod (so tests that don't touch
  PII keep booting). The fix is documentation + a better
  runtime error: `.env.example` now ships a `PII_KMS_*` block
  with key-gen one-liners, and `patient.service.ts` throws a
  message pointing at `.env` / `.env.example` instead of "config
  loader should have rejected".

No schema changes. No behaviour changes on the happy path. Typecheck
+ lint clean.



### T1-5 follow-up — communication outbound wired to the replay queue

Fourth and final outbound service opt-in for the
NhcxReplayWorker. Same template as eligibility / preauth /
claim-submit; the four highest-stakes outbound calls now all
survive NHCX gateway downtime.

- `CommunicationService.sendOutbound()` wraps the adapter call
  in classify-and-park:
  - **Transient** → server-gen correlationId, outbound row at
    `queued_for_retry`, ClaimEvent (`communication.outbound_sent`)
    is ALSO written so the case-detail timeline shows the message
    as sent (with a `queued: true` payload flag distinguishing
    parked from gateway-confirmed messages). Operator-facing:
    same return shape as a normal send — no error surfaced.
  - **Permanent** → bubbles up unchanged.
- `replayQueuedCommunication()` handler registered at bootstrap
  for operation `'communication.request'`:
  - Lighter template than preauth/claim-submit because
    communications are **non-transitioning** — no state machine
    to coordinate. No claim-status idempotency guard needed.
  - Re-reads the original message text + reply target from the
    `communication.outbound_sent` ClaimEvent payload that
    `parkCommunicationForReplay` wrote.
  - On adapter success: `markReplaySucceeded`. No further
    transitions or claim updates.
  - Transient again → `'transient'`; Permanent → `'permanent'`.

Edge case enabled: **T1-5** for the communication outbound flow.
Gateway outages no longer cause the proactive hospital-to-payer
messages from PR #94 to fail hard.

### Outbound replay coverage

| Service | Operation | PR |
|---|---|---|
| Eligibility | `eligibility.verify` | #100 |
| Preauth | `preauth.submit` | #101 |
| Claim submit | `claim.submit` | #102 |
| Communication | `communication.request` | this PR |

Discharge intentionally not wired — the discharge flow rides on
top of `communication/request` via `buildCommunicationBundle`,
so the communication wiring above covers its transient path.
PMJAY task/submit (preauth-cancel, claim-reprocess) and
insurance-plan lookup remain unwired; both are PMJAY-only and
much lower frequency.



### T1-5 follow-up — claim-submit wired to the replay queue

Third service opt-in to the NhcxReplayWorker. Same template as
the preauth wiring; claim-submit is the highest-stakes adapter
call on the platform — final claim, irrecoverable on permanent
gateway loss.

- `ClaimSubmitService.submit()` wraps `this.nhcx.submitClaim` in
  classify-and-park:
  - **Transient** → server-gen correlationId, outbound row at
    `status='queued_for_retry'`, claim stays at `CLAIM_QUEUED`,
    response carries empty `claimRefNum` (matches real-mode
    "awaiting callback" shape until replay succeeds).
  - **Permanent** → bubbles up unchanged.
- `replayQueuedClaim()` handler registered at module bootstrap
  for operation `'claim.submit'`:
  - **Idempotency guard**: retries only while claim at
    `CLAIM_QUEUED`. Acknowledged / approved / rejected / query
    raised / closed → `markReplayExhausted`.
  - Re-derives adapter request from current state
    (`PreauthDraft` for clinical fields, `Document.list` for
    attached docs, `Claim.claimAmount` for finalAmount,
    `fhirContext.build` for patient + coverage).
  - **Success path**: `markReplaySucceeded` + stamps `claimRefNum`
    on the claim row + (stub mode only) drives `claim.acknowledged`
    transition. Real mode leaves the claim at `CLAIM_QUEUED` for
    the inbound `claim/on_submit` callback to drive the ack.
  - Transient again → `'transient'`. Permanent → `'permanent'`.
- No schema changes, no new permission.

Edge case enabled: **T1-5** for the claim submit flow. NHCX
gateway outages no longer require operator intervention on the
final claim — the worker re-issues once the gateway recovers,
the gateway's idempotency at the claimRefNum boundary prevents
double-acts.

Remaining T1-5 follow-ups (each ~3-5 files, same template):
communication outbound, discharge.



### T1-5 follow-up — preauth wired to the replay queue

Second service opt-in to the NhcxReplayWorker. Mirrors the
eligibility template; same pattern remaining services will adopt.

- Moved `transient-errors.{ts,spec.ts}` from `modules/eligibility/`
  to `modules/integration/` so all services share the classifier.
  `classifyAdapterError` re-exported from the integration barrel.
  Eligibility import updated.
- `PreauthService.submit()` wraps `this.nhcx.submitPreauth` in
  classify-and-park:
  - **Transient** → new outbound row at `status='queued_for_retry'`
    (60s initial backoff). Claim stays at `PREAUTH_QUEUED`
    (already set by the `preauth.submitted_internally` transition
    earlier in the flow). Operator-facing response carries an
    empty `payerRefNum` and the existing claim status — same
    shape the real-mode "awaiting callback" path returns.
  - **Permanent** → bubbles up unchanged.
- `PreauthService.replayQueuedPreauth()` registered at module
  bootstrap. Strategy:
  - Idempotency guard: only retries while claim is at
    `PREAUTH_QUEUED`. Acknowledged / approved / rejected / query
    raised / cancelled → row marked exhausted, worker stops.
  - Re-derives the adapter request from current persistent state
    (PreauthDraft + Claim + FhirContext) — the saved draft snapshot
    captures the clinical fields the operator submitted.
  - On adapter success: `markReplaySucceeded` + (stub mode only)
    drives the `preauth.acknowledged_by_payer` transition. Real
    mode leaves the claim at `PREAUTH_QUEUED` for the inbound
    `preauth/on_submit` callback to drive the ack.
  - Transient again → `'transient'` (worker re-parks with new
    backoff). Permanent → `'permanent'`.

Edge case enabled: **T1-5** for the preauth flow. NHCX gateway
outages no longer require operator intervention on the preauth
submit step.

Remaining T1-5 follow-ups (each ~3-5 files, same template):
claim-submit, communication outbound, discharge.



### T1-5 follow-up — eligibility wired to the replay queue

Activates the dormant T1-5 foundation for the first service. Pattern
established here is what every subsequent service (preauth,
claim-submit, communication outbound, payment notice) will copy.

- New `apps/api/src/modules/eligibility/transient-errors.ts` —
  pure classifier that distinguishes transient adapter errors
  (network / 5xx / timeout) from permanent (4xx / JWE decrypt /
  unknown). Unknown shapes are conservatively treated as
  permanent so the worker doesn't loop on something we don't
  recognise. 13-case unit spec covers JWE adapter's actual error
  formats + boundary patterns.
- `EligibilityService.run()` wraps `this.nhcx.verifyEligibility`
  in try/catch:
  - On **transient** error → server-generated correlationId,
    new outbound row at `status='queued_for_retry'` (initial
    backoff 60s), claim stays at `ELIGIBILITY_CHECK_PENDING`.
    Operator-facing response mirrors the real-mode
    "awaiting callback" shape — no error surfaced to the UI.
  - On **permanent** error → bubbles up unchanged.
- `EligibilityService.replayQueuedEligibility()` — replay
  handler registered via `NhcxReplayWorker.registerHandler()` at
  module bootstrap. Strategy:
  - Re-derives the adapter request from CURRENT persistent
    state (claim row + case row + patient row). The original
    `rawRequest` is forensic only; replay reflects whatever
    the operator's done since.
  - **Idempotency guard**: if the claim has moved past
    `ELIGIBILITY_CHECK_PENDING` (operator manually transitioned,
    or an inbound callback already landed), the replay is a
    no-op and the row is marked exhausted so the worker stops
    re-parking it.
  - On adapter success: marks the queued row succeeded + drives
    the `eligibility.verified` / `eligibility.failed`
    transition. The replay uses a NEW correlationId; gateway
    treats it as a fresh request.
  - On transient again: returns `'transient'` to the worker
    which re-parks with new backoff.
  - On permanent: returns `'permanent'` to mark the row failed.
- No new schema. No new permission.

Edge case enabled (depends on PR #98 foundation):
**T1-5** for the eligibility flow. NHCX gateway outages no
longer require operator action on the eligibility step — the
worker drains the queue once the gateway recovers.

Follow-ups: same pattern applied to PreauthService,
ClaimSubmitService, CommunicationService outbound, payment
notice. Each is ~3-5 files.



### T1-5 — NHCX outbound replay queue (foundation)

- New status value `queued_for_retry` on
  `IntegrationStatusSchema` for outbounds that failed
  transiently and are parked for replay.
- New column `IntegrationMessage.nextRetryAt: DateTime?` plus
  an index on `(status, nextRetryAt)` driving the worker poll
  query. Migration `20260601000000_integration_replay_queue`
  applied via plain `ADD COLUMN` + index — no data backfill,
  safe to deploy under load.
- New service helpers in `IntegrationMessageService`:
  - `markQueuedForRetry()` — parks a failed outbound with
    exponential backoff (60s, 5m, 30m, 2h, 6h capped). Increments
    `retryCount` atomically.
  - `findReplayable()` — cross-tenant poll for rows whose
    `nextRetryAt` has lapsed (direct prisma access; mirrors
    `NotificationRetryWorker.runOnce`).
  - `markReplaySucceeded()` — flips to `succeeded` + writes
    the inbound mirror row.
  - `markReplayExhausted()` — flips to `failed` when retries
    are spent.
  - `REPLAY_BACKOFF_SECONDS` + `REPLAY_MAX_ATTEMPTS` (5) constants.
- New `NhcxReplayWorker` (`OnApplicationBootstrap` +
  `OnApplicationShutdown`) running every 30s. Services that
  want their outbounds queued register a handler at bootstrap:
  ```ts
  this.replay.registerHandler({
    operation: 'eligibility.verify',
    handle: async (ctx) => {
      // re-derive request from current claim state, call adapter,
      // call markReplaySucceeded on success
      return 'succeeded' | 'transient' | 'permanent';
    },
  });
  ```
- Worker outcomes: `succeeded` (counted, no further action;
  handler is responsible for calling `markReplaySucceeded`),
  `transient` (worker re-parks with new backoff),
  `permanent` (worker marks the row exhausted). Unhandled
  exceptions are treated as `transient`.
- 7-case unit spec for the worker: registration semantics,
  dispatch table, missing-handler skip, succeeded count-only,
  transient re-park with incremented attempts, permanent mark,
  thrown-error re-park, multi-row batch.
- Edge case enabled: **T1-5** foundation. Individual service
  wiring (eligibility, preauth, claim-submit, communication,
  payment, etc.) lands per-slice in follow-ups — each is a
  small additive change: call `markQueuedForRetry()` on
  transient adapter errors + register a handler at bootstrap.



### T2-15 — IRDAI SLA timers on every claim

- New `apps/api/src/modules/claim/sla-deadline.ts` — pure
  functions that derive SLA state from a claim's event timeline.
  No DB access, no NestJS imports; unit-tested with synthetic
  event streams covering every state in the enum.
- IRDAI windows: **1 hour for preauth** (`preauth.submitted_internally`
  → first `preauth.{approved,rejected,partially_approved,query_received}`),
  **3 hours for claim** (`claim.submitted_internally` → first
  `claim.{approved,rejected,partially_approved,query_received}`).
- SLA states: `on_track` (<50% elapsed), `at_risk` (≥50%),
  `breached` (past deadline, not decided), `met` (decided in window),
  `missed` (decided after window). PMJAY resubmit-on-query keeps
  the earliest submit as the IRDAI-clocked event — payers can't
  game the timer by triggering queries.
- `CaseService.getById` pulls each claim's events alongside the
  claim row and stamps the computed SLA onto every claim in the
  case-detail response (`claim.sla.preauth`, `claim.sla.claim`).
  No new tables, no schema migration.
- New schemas in `packages/contracts/src/sla.schema.ts`:
  `SlaPhaseSchema`, `SlaStatusSchema`, `SlaStateSchema`,
  `ClaimSlaSchema`, plus `IRDAI_PREAUTH_WINDOW_MINUTES` (60) and
  `IRDAI_CLAIM_WINDOW_MINUTES` (180) constants.
- New web component `<SlaPill>` mounted on the case-detail hero.
  Renders both preauth + claim pills with colour (teal /
  amber-700 / error), icon, and minutes-left or
  minutes-overdue. Re-ticks every 30s while pending so the
  operator sees the timer drain without refreshing. Glass
  background, tabular numerics, sentence case.
- Unit tests cover every status path + boundary conditions
  (duplicate submits, out-of-order events).
- Integration test plants events directly via Prisma to assert
  the API surface returns the expected state across breached /
  met / on_track / claim-phase scenarios.
- Edge case enabled: **T2-15** IRDAI SLA timers visible on every
  claim.
- List-card SLA pills (under /cases) deferred to a follow-up:
  `CaseSummary` doesn't include claim events; rolling them in
  requires a list-endpoint change.



### T3-1 — CFO variance dashboard

- New module `apps/api/src/modules/analytics/` with
  `VarianceService` + `VarianceController`. Three read endpoints
  gated on `analytics.view`:
  - `GET /analytics/variance/summary` — KPI tiles (total billed /
    approved / paid / billed-variance / short-pay) plus aging
    buckets (`d0_7`, `d8_14`, `d15_30`, `d31_plus`) over
    unsettled claims.
  - `GET /analytics/variance/by-payer?limit=N` — top-N payers
    ordered by net leakage (billed-variance + short-pay), with
    variance rate.
  - `GET /analytics/variance/claims?bucket=&payerCode=&limit=` —
    drill-down list filtered by either dimension.
- New schemas in `packages/contracts/src/variance.schema.ts`:
  `VarianceAgingBucketSchema`, `VarianceSummaryResponseSchema`,
  `VarianceByPayerResponseSchema`, `VarianceClaimsResponseSchema`.
- New web route `/admin/variance` — KPI tiles, aging-bucket
  rail (click to filter), top-payer table, drill-down with
  active filter pills. Glass cards, teal + amber only, sentence
  case, tabular-nums on every amount. Sidebar nav entry added
  under Operations.
- No new Prisma model, no migration — pure read aggregations
  over existing `Claim` + `Case` rows, RLS-scoped via
  `runInTenantContext`.
- Integration test plants four claims across two tenants and
  verifies summary math, bucket distribution, by-payer ordering,
  filters, invalid-bucket 422, RBAC, cross-tenant isolation.
- Edge case enabled: **T3-1** variance dashboard.
- Reuses existing `analytics.view` permission — no seed changes
  required.

### T3-2 — lump-sum UTR allocation

- New endpoints under `/settlement/remittance`:
  - `GET /candidates?payerCode=&limit=` — open Settlement rows
    (status `manual_match_pending` or `short_paid`), enriched with
    patient name and current received amount, ordered by
    `expectedAmount desc`.
  - `POST /lump-sum` — atomic application of an operator-built
    allocation. Body: `{ bankTxnId, totalAmount, receivedAt?,
    payerCode?, allocations: [{ claimId, allocatedAmount }] }`.
- `RemittanceService.proposeCandidates()` + `allocateLumpSum()`.
  Each per-claim leg routes through the existing
  `SettlementService.recordReceipt` path, so state-machine
  semantics (`payment.received`, `payment.short_paid`) and audit
  trail (per-claim `ClaimEvent` + `IntegrationMessage`) are
  identical to manual receipts. Failed legs do NOT roll back
  applied legs (mirrors Slice AL).
- Variance guard: `sum(allocations.allocatedAmount) !== totalAmount`
  → `422 VALIDATION_FAILED` with field `allocations`.
- Duplicate-UTR guard: any prior Settlement in the same tenant
  with the same `bankTxnId` rejects the new allocation with
  `422 VALIDATION_FAILED` on field `bankTxnId`.
- New web component `<LumpSumAllocationPanel>` mounted above the
  existing Slice-AM CSV batch panel on `/admin/remittance`. Glass
  card, teal/amber only, live sum-vs-total banner that gates the
  Allocate button.
- No new Prisma table — `Settlement.bankTxnId` is the existing
  join key for finance reverse-lookup; per-claim `claim_event`
  rows are the audit trail.
- Edge case enabled: **T3-2** lump-sum payment reconciliation
  (CFO weekly batch matching across many claims).
- Reuses the existing `settlement.upload_eob` permission — same
  operator audience as the CSV batch flow.

Theme: **v1 launch readiness.** OCR v1 (Python repo, parallel),
intake-flow consent capture (TS), hard consent enforcement
rollout (TS, gated on intake), production deploy work (OVH KMS,
k8s manifests). Sprint 9 closed the audit-compliance + per-payer
normalisation axes; Sprint 10 takes the platform from
feature-complete to production-ready.

### Stage 5 — hospital-initiated `communication/request` outbound

- New module `apps/api/src/modules/communication/` with
  `CommunicationService.sendOutbound()` + `recordInbound()` and
  `CommunicationController` exposing
  `POST /cases/:caseId/claims/:claimId/communications`
  (body `{ text, inReplyToCorrelationId? }`) and
  `GET /cases/:caseId/communications`.
- Adapter additions: `AdapterCommunicationSendInput/Result` +
  `sendCommunication()` on `NhcxAdapter`. Stub echoes the input;
  `NhcxJweAdapter` wraps the existing `buildCommunicationBundle`
  under operation `communication/request`.
- Two new non-transitioning `ClaimEvent` types:
  `communication.outbound_sent` and `communication.inbound_received`.
  `resultingStatus` is pinned to the claim's current status — these
  events DO NOT move the state machine.
- New permissions `communication.send` + `communication.view`
  seeded on `tenant_admin`, `billing_manager`,
  `insurance_desk_executive`.
- Inbound dispatcher now mirrors every payer-pushed Communication
  payload into a `communication.inbound_received` ClaimEvent so
  the case-detail timeline shows both directions in chronological
  order. The existing `preauth.applyDecision({kind:'query_received'})`
  state transition is preserved.
- Web: `CommunicationApi` client + `<CommunicationsPanel>`
  mounted on `/cases/[id]`. Glass card, teal + amber only,
  sentence case, send-form CTA mirrors the login page button
  height + radius.
- Edge cases enabled by this slice (commit-message refs):
  **T2-6** pre-auth approved-less variance question,
  **T2-10** release-and-settle-later notes,
  **T3-3** partial-approval line-item query.
- NHCX sandbox: continues to run against `NhcxStubAdapter`
  (confirmed conscious choice with operator — no real-mode env
  template exists yet).

### CG — DPDP §6 hard-enforcement flag (`tenant.requireConsent`)

- New boolean column `tenant.requireConsent` (default `false` for
  back-compat). When true, `FhirContextService.build` throws
  `ConsentRequiredError` (HTTP 412, code `CONSENT_REQUIRED`) at
  the start of any preauth / claim / discharge flow if no active
  consent grant exists for the (patient, consentType) tuple.
  When false, CB's soft-binding behaviour is preserved (read
  proceeds with `consentGrantId=null`; the BU dashboard's
  "unbound access in 24h" surfaces the gap).
- New admin endpoint `POST /admin/tenants/:tenantId/require-consent`
  with body `{ enabled: boolean }`. Gated on
  `tenant.security.update`. Cross-tenant flips rejected. Each flip
  writes a `TENANT_REQUIRE_CONSENT_UPDATED` audit row with
  before/after state (governance retention class).
- New `ConsentRequiredError` domain error + `CONSENT_REQUIRED`
  error code. The problem-detail payload includes `patientId` +
  `consentType` in `errors[]` so the frontend's consent-capture
  modal pre-populates and the operator can grant + retry without
  re-entering identifiers.
- Frontend modal copy lands in `error-codes/titles.ts`: "Consent
  required before processing" with a "Capture consent" primary
  action.
- Rollout flow per tenant: (1) ship CF intake capture (done), (2)
  backfill historical patients with grants, (3) confirm BU
  dashboard "unbound access in 24h" reads zero, (4) flip the
  flag via the admin endpoint, (5) monitor for 24h. Flipping
  back to `false` is supported for incident response.
- 5 e2e canaries on `consent-hard-enforcement.e2e-spec.ts`:
  default state preserves CB soft binding; admin endpoint flips
  on with audit row; missing grant after flip throws
  CONSENT_REQUIRED; active grant after flip → context builds;
  flip back → soft binding resumes.

### CF — intake-flow consent capture

- `POST /cases` accepts an optional `consent` block alongside the
  existing `patient` PII block. When supplied, the case + patient
  + consent record + both audit rows (`CONSENT_GRANTED` from BT +
  the existing case-create audit) commit atomically inside one
  tenant tx — a failure on any of them rolls back all three.
- New `IntakeConsentSchema` in `@claims/contracts` (consent type,
  data categories, purposes, lawful basis, source, evidence,
  optional expiresAt). Composes the existing BT `ConsentEvidenceSchema`
  + `ConsentTypeSchema` + `LawfulBasisSchema` rather than
  duplicating shapes.
- `ConsentService.grantWithTx(tx, input)` — sibling of `grant()`
  that runs inside a caller's existing tenant tx. CaseService
  calls this so intake stays atomic; the existing `grant()`
  endpoint flow (operator captures consent later via the consents
  page) keeps using `grant()` which opens its own tx.
- 422 guard: when a request supplies `consent` but no `patient`
  block, the service rejects — a consent has nothing to bind to
  without a patient row. Error message includes "patient PII"
  copy so the frontend's error modal can surface a useful prompt.
- Web `/cases/new` form now collects:
  - Patient PII (Aadhaar, ABHA, mobile) in an encrypted-at-rest
    section.
  - DPDP §6 consent capture in a yellow-warning section that
    auto-derives `consentType` from the primary rail (NHCX →
    `nhcx_processing`, PMJAY → `pmjay_processing`, self-pay → no
    consent block since no rail-driven processing happens).
    Operator picks the acknowledgement method (in-person signed
    form, ABHA OTP, tele-consent call, verbal counter-signed) +
    edits the verbatim notice text that gets preserved in the
    consent's `evidence` JSON for audit reconstruction.
- 4 new e2e canaries on `intake-consent-capture.e2e-spec.ts`:
  case + patient + consent commit atomically; back-compat path
  without PII still works (Sprint 2 walking-skeleton); consent
  without PII is rejected 422; PMJAY rail captures
  `pmjay_processing` consent type with the right scope.
- Unblocks the future tenant-level `requireConsent` flag for
  hard enforcement — once intake captures consent on every new
  case, the flag can be flipped per tenant without breaking
  preauth/claim flows.

## Sprint 9 — TBD (May 2026)

Theme: **per-payer EOB normalisation + perf hardening + parallel
Python OCR machine.** Sprint 8 closed the audit-retention axis;
Sprint 9 focuses on the EOB extraction surface (so settlement
reviewers see canonicalised deduction categories from any of the
top six payers) plus production-cron wiring + connection-pool /
index work for cross-region Postgres.

### CD — perf indexes for the BU dashboard hot queries

- Three composite indexes added in migration
  `20260530000000_audit_perf_indexes`:
  - `audit_log(tenantId, retentionClass, occurredAt)` — backs BU's
    "past-floor count per tenant per class" query. The existing
    `(retentionClass, occurredAt)` index lacks tenantId leading,
    so PG either scanned every tenant's rows or fell back to
    `(tenantId, occurredAt)` and filtered retentionClass on the
    heap. With this composite, the
    `WHERE tenantId = T AND retentionClass = X AND occurredAt < cutoff`
    pattern becomes a bounded index range scan.
  - `data_access_event(tenantId, action, occurredAt)` — backs BU's
    recent-decrypts list (`WHERE tenantId AND action='decrypt'
    ORDER BY occurredAt DESC LIMIT 20`) and the unbound-count
    query in the past 24 hours.
  - `consent_record(tenantId, updatedAt)` — backs BU's recent-
    changes list which orders by `updatedAt` to surface fresh
    withdrawals alongside fresh grants.
- All three mirrored as `@@index` on the Prisma schema so future
  `prisma generate` doesn't drop them.
- No `CONCURRENTLY` (Prisma migrations run inside a single tx
  which can't host CONCURRENTLY). Ops replaying these on a hot
  prod table should re-create them via `CREATE INDEX
  CONCURRENTLY` off-Prisma if downtime is a concern; the index
  shape is the same.

### CC — production cron wiring (pg_cron + cloud-cron + runbook)

- New `infra/cron/pg-cron-setup.sql` — paste-and-run script for ops
  to schedule per-class `audit_retention_sweep` calls under
  pg_cron at 02:30–02:55 IST nightly. Idempotent (drops prior
  schedules before recreating). The retention class floor-days
  values mirror `RETENTION_FLOOR_DAYS` in
  `apps/api/src/modules/audit/retention-classes.ts` — keep them in
  lockstep when the floor map changes (e.g. if DigiSparsh-lending
  slips out of v1 and `financial` drops from RBI 10y to IRDAI 5y).
- New `infra/cron/cloud-cron.yaml` — generic example mapping onto
  k8s CronJob / OVH cron / GCP Cloud Scheduler / AWS EventBridge
  for the breach detector (which can't run inside Postgres because
  it needs Prisma + per-tenant `runInTenantContext` inserts) and
  for the retention sweep when pg_cron isn't available. Pick pg_cron
  OR the cloud-cron retention-sweep job, not both.
- New `docs/infra/production-cron.md` — runbook covering both
  paths, inspection queries, cadence rationale (why nightly
  retention + every-15-min breach), manual-fallback CLI commands,
  and a list of v1-deliberately-not-scheduled jobs (consent
  expiry sweep + erasure auto-retry; the BU dashboard surfaces
  both for triage).
- No code changes. The BP `audit_retention_sweep` SQL function +
  the BS `BreachDetectorService.scan()` already exist; CC is the
  operational deliverable that gets them running on cadence in
  production.

### CB — consent threading on decrypt paths (preauth / claim / discharge / eligibility)

- `FhirContextService.build` gains an optional `consent`
  parameter (`actorUserId`, `actorType`, `purpose`,
  `correlationId`). When supplied, the service:
  1. Resolves consent type from `tenant.pmjayMode` — PMJAY tenants
     bind against `pmjay_processing`, others against
     `nhcx_processing`.
  2. Best-effort `ConsentService.findActiveFor(...)` lookup. When
     a grant exists the `consentGrantId` threads into
     `PatientService.getDecrypted` ctx so the `data_access_event`
     row binds back to the grant.
  3. When no grant exists the read still proceeds (soft
     enforcement) and the access-ledger row records
     `consentGrantId=null`. The BU dashboard's
     `unboundAccessCountLast24h` surfaces these gaps for
     compliance triage.
- Threaded through every existing `fhirContext.build(...)` call
  site: preauth submit (`purpose='preauth.submit'`), preauth
  cancel (`'preauth.cancel'`), preauth respond-query
  (`'preauth.respond_query'`), claim submit (`'claim.submit'`),
  claim reprocess (`'claim.reprocess'`), discharge submit
  (`'discharge.submit'`).
- `EligibilityService.run` calls `getDecrypted` directly (not
  through `FhirContextService.build`) and got the same shape: it
  now reads `tenant.pmjayMode`, looks up the matching consent
  type's active grant, and threads `consentGrantId` into the
  decrypt ctx with `purpose='eligibility.verify'`.
- 3 e2e canary cases on `consent-binding-on-decrypt.e2e-spec.ts`:
  granted nhcx_processing → bound; no grant → null binding;
  PMJAY tenant with only nhcx_processing grant → null binding
  (consent type mismatch).
- Hard enforcement (throwing on missing grant) is **deliberately
  deferred** to a future slice gated on a tenant-level
  `requireConsent` flag — turning it on tenant-wide before
  consent capture is wired into intake would break every
  preauth submit on tenants without backfilled grants.

### CE — top-4 remaining payer extractors (ICICI Lombard, HDFC Ergo, Mediassist, Paramount)

- Closes the top-six payer coverage opened in CA. Same
  `PayerExtractor` shape, same canonical `DEDUCTION_CATEGORIES`
  taxonomy, four new payer-specific implementations:
  - **ICICI Lombard** — claim-ref `ICL` / `ICICI/` / `ILGI`;
    name-regex `\bicici\s*lombard\b`; payer-specific category
    rules including "room-rent capping → sublimit" (more
    specific than `cap_exceeded`) and "first 24-hour exclusion".
  - **HDFC Ergo** — claim-ref `HE/` / `HDFC/` / `HEHI`;
    name-regex `\bhdfc\s*ergo\b`; "deductible → copay" and
    "Reasonable & Customary → exclusion" (HDFC's signature
    aesthetic-procedure denial copy, supports both `&` and
    `and` forms).
  - **Mediassist** — claim-ref `MA-` / `MAS/` / `MEDI`;
    name-regex `\bmedi[\s-]?assist\b` (handles "Medi Assist",
    "Medi-Assist", "Mediassist"); TPA-specific
    "consumables and disposables → non_payable_items",
    "proportionate deduction → sublimit".
  - **Paramount** — claim-ref `PHS` / `PHI` / `PMT-`;
    name-regex `\bparamount\s*health\b`; "co-share → copay",
    "investigation in progress → missing_documents" (held-
    pending-docs is operationally the same as missing-docs).
- All four wired into `PayerExtractorsModule` after Star + Bajaj
  in registry order (Star, Bajaj, ICICI, HDFC, Mediassist,
  Paramount). First-match-wins detection means tie-breaks rarely
  matter — the six payers are mutually exclusive on claim-ref
  prefix.
- 36 new unit tests (9 per payer + 1 extra TPA-name-detection
  case in the registry suite) bringing payer-extractor coverage
  to **53 tests**: every payer's detection signals (each ref
  prefix variant + name regex + reason-copy fallback), every
  canonical category mapping, fallback-to-unknown, registry
  routing, and TPA detection that survives a non-matching
  claim-ref.

### CA — per-payer EOB extractor framework + Star Health + Bajaj Allianz

- New `payer-extractors` module with a `PayerExtractor` interface
  (`code`, `detect(eob)`, `normalise(eob)`) and a registry-driven
  `PayerExtractorService.detectAndNormalise(eob)` that iterates the
  registered extractors and returns the first match's normalised
  `ExtractedEob` plus a `payerCode`. Generic fallback when no
  detector matches — eob falls through unchanged with
  `payerCode='generic'`.
- Two worked extractors land:
  - **Star Health** — detects on `claimRefNum` starting with
    `STAR/` or 'Star Health' in reason copy. Maps Star's
    deduction phrasing (Cap exceeded, Co-pay, Sub-limit,
    Pre-existing, Exclusions, Non-payable items, Missing
    documents) to the canonical taxonomy.
  - **Bajaj Allianz** — detects on `BAGI`/`BAJAJ` claim ref
    prefix or 'Bajaj Allianz' in reason copy. Maps Bajaj-specific
    phrasing (Capping, Co-payment, Inner limit, PED, Excluded
    items, Insufficient documentation) to the same taxonomy.
- Canonical `DEDUCTION_CATEGORIES` shared across the module:
  `cap_exceeded`, `copay`, `exclusion`, `pre_existing`,
  `sublimit`, `non_payable_items`, `missing_documents`,
  `non_admissible`, `unknown` (catch-all so settlement UI can
  surface unmapped phrasing for taxonomy review).
- Extended `ExtractedEob` with an optional `payerCode` field +
  `EobExtractedFieldsSchema.payerCode` on the contract. The Python
  OCR machine MAY pre-detect (when the layout model knows the
  payer); the TS service respects an explicit value if set,
  otherwise runs detection itself.
- `DocumentService.extractEob` now wraps the OCR adapter call
  with `payerExtractorService.detectAndNormalise(...)` so the
  HTTP response carries `fields.payerCode` + canonicalised
  deduction categories.
- 17 unit tests on Star, Bajaj, and the registry/dispatch:
  detect signals (claim-ref + name regex + reason-copy),
  normalise mappings for every known category, fallback to
  `unknown`, generic-fallback path, registry-order tie-breaks.

## Sprint 8 — closed 2026-05-09 (May 2026)

Theme: **audit retention on the strictest-of-three floor (DPDP Act
2023 + DPDP Rules 2025 + IRDAI 5y for claims + RBI 10y because
DigiSparsh-lending is planned in v1)**. Sprint 8 puts the schema
and write-time stamping in place; subsequent slices ship the
sweeper (BP), erasure-on-request (BQ), data-access ledger (BR),
breach detection (BS), consent record + UI (BT), and the
compliance dashboard (BU).

### BU — DPDP / IRDAI / RBI compliance dashboard

- New `GET /admin/compliance/dashboard` endpoint returns one
  tenant-scoped rollup payload covering every section of the
  audit-retention surface in a single round-trip. Permission:
  `audit.view` (broad) — operators, DPOs, and compliance reviewers
  all need read access. The breach `notify` / `dismiss` actions on
  the page additionally require `breach_incident.manage`; the
  existing BS endpoints gate those calls.
- `ComplianceDashboardService.load(tenantId)` runs ~14 bounded
  queries inside a single `runInTenantContext` transaction (one
  GUC set, one connection):
  - Six retention-class rows with `total` + `pastFloor` counts so
    operators can spot misclassified rows / a stale BP sweeper.
  - Last 10 erasure requests with a `blockingClaimsCount` rollup
    + 90-day window completed/rejected counts.
  - Last 20 decrypt events with a join to `consent_record` so
    each row carries the bound consent's status (`granted` / `withdrawn`
    / `expired` / `superseded` / `unbound`). Withdrawn-but-still-
    referenced is informational, not a breach — it surfaces in the
    BU UI as an amber badge so DPOs can review.
  - Past-24h `unboundAccessCountLast24h` — count of decrypt events
    with `consentGrantId=null`. Engineering triage signal: callers
    that haven't been wired to BT's consent thread.
  - Breach incident counts per status + open-list ordered by
    `dpdpNotificationDueAt asc`, with `overdue=true` flag computed
    at read time when `dueAt < now`.
  - Consent counts per status + last 10 grant/withdraw rows
    ordered by `updatedAt desc` (so fresh withdrawals float
    alongside fresh grants).
- New web admin route `/admin/compliance` renders the payload as
  six sections: top-row count cards (open breaches, notified, active
  consents, unbound access), a red banner counting overdue breaches,
  retention-class table, open-breach table with **inline notify /
  dismiss buttons** (calls BS endpoints; window.prompt for the
  required dismiss reason), recent decrypt events with consent
  badges, recent erasures, recent consent changes. "Run breach
  scan" button hits BS's `POST /breach-incidents/scan` for
  on-demand sweeps without leaving the page.
- 5 e2e canary cases on `compliance-dashboard.e2e-spec.ts`:
  endpoint returns the full rollup with all six retention classes
  even when totals=0; an open breach with `dpdpNotificationDueAt`
  in the past is flagged `overdue=true`; bound vs unbound decrypt
  events report the right `consentStatus` + bump
  `unboundAccessCountLast24h`; reader without `audit.view` → 403;
  cross-tenant payload sees only the calling tenant's counts (RLS
  canary on every aggregation query).
- Closes the audit-retention axis. With BO–BU merged, Sprint 8
  is ready to exit — write `docs/sprint-8-exit.md` matching the
  prior sprint format when the user signals close.

### BT — DPDP §6 / Rule 8 consent record + access-ledger binding

- New `consent_record` table holds operator-captured DPDP consents.
  One row per `(patient, consentType)` grant lifecycle: a withdrawn
  / expired / superseded row sits alongside a later granted row;
  `findActiveFor` reads the most-recent `granted` row whose
  `expiresAt` is null or in the future. RLS = same-tenant SELECT /
  INSERT / UPDATE (status flips for withdrawal). DELETE blocked —
  consent records are themselves a compliance artifact and outlast
  the data they authorise. FK to `patient` is `ON DELETE NO
  ACTION` so a future BQ erasure scrubs the patient row in place
  without taking the consent record with it.
- Captured fields: `consentType` (`nhcx_processing` | `pmjay_processing`
  | `analytics` | `communication`), `dataCategories` + `purposes`
  JSON arrays, `lawfulBasis` (`consent` | `legitimate_use` |
  `legal_obligation` | `public_interest`), `source` (free-text
  channel descriptor), `evidence` JSON snapshot of the notice
  shown to the data principal at consent time, optional
  `expiresAt` and `documentId` (link to a stored paper-form
  scan), `capturedByUserId`, `withdrawnAt` + `withdrawalReason`
  on flip.
- New `ConsentService` with five operations:
  - `grant(input)` — create a row with status='granted'; verifies
    patient belongs to tenant; emits `CONSENT_GRANTED` audit row
    (consent retention class — held until withdrawal + statutory
    floor under Rule 8).
  - `withdraw(id, reason)` — flip granted → withdrawn with the
    required reason for §13 traceability; rejects when status
    isn't 'granted'; emits `CONSENT_WITHDRAWN` audit row.
  - `list(filter)` — tenant-scoped, optional filters on patient /
    type / status, ordered by `grantedAt desc`.
  - `findActiveFor(tenant, patient, type)` — returns the most-
    recent granted row covering the (patient, type) tuple; null
    when none exists.
  - `requireConsent(...)` — call-site guard; throws
    ValidationFailedError when no active grant exists. Service
    code gating PII reads (preauth / claim submit) calls this
    before decryption.
- **Access-ledger binding**: `data_access_event` gains a nullable
  `consentGrantId UUID` column. `DataAccessLogService` accepts it
  in the write input; `PatientService.getDecrypted` extends ctx
  with `consentGrantId`. Service callers (eligibility / preauth /
  claim submit slices in subsequent work) thread the active grant
  id from `findActiveFor` into the decrypt ctx, and the row's
  binding back to the consent grant lets BU's compliance dashboard
  answer "show every read authorised by this grant" with a single
  index lookup. Loose-coupled by uuid (no FK) so the ledger row
  outlives any future consent-record migration.
- New endpoints (`/consents`):
  - `POST /consents` — manage; capture a new grant.
  - `GET  /consents` — view; list with optional patient / type / status filters.
  - `GET  /consents/:id` — view; row.
  - `POST /consents/:id/withdraw` — manage; flip + reason.
- New permissions: `consent.view` + `consent.manage`. View is
  granted broadly (intake desks need to see whether a patient has
  consented before processing); manage is restricted to roles that
  capture consent at admission and the DPO who handles
  withdrawals. Default seed: `platform_admin` and `tenant_admin`
  get both; `billing_manager` and `insurance_desk_executive` get
  both (they're the operator-level roles capturing consent at
  intake); `pmam`, `doctor`, `finance_viewer`, `read_only` are
  intentionally excluded.
- New audit events: `CONSENT_GRANTED`, `CONSENT_WITHDRAWN` —
  classified as `consent` retention class (held until withdrawal
  + statutory floor; distinct from governance because the
  withdrawal of a consent is itself a data-principal right).
- New web admin route at `/admin/consents` mirrors the audit
  viewer pattern: filterable list (patient / type / status) with
  inline withdraw button (prompts for reason) for `granted` rows.
- 8 e2e canary cases on `consent-record.e2e-spec.ts`: grant lands
  status='granted'; list filters by patient + status; withdraw
  flips status with reason + rejects second withdraw (422);
  `requireConsent` throws when no grant + returns row when active;
  `findActiveFor` excludes expired (past `expiresAt`) and
  withdrawn rows; `PatientService.getDecrypted` threads
  `consentGrantId` into the resulting `data_access_event` row;
  reader without `consent.view` → 403; cross-tenant GET → 422
  (RLS canary).

### BS — DPDP §8(6) breach detection + 72h notification template

- New append-only-on-DELETE `breach_incident` table records both
  auto-detected anomalies and operator-filed manual reports. Status
  lifecycle (`detected → notified | dismissed`) is enforced by the
  service; RLS UPDATE policy permits same-tenant flips so the
  controller can mark notified / dismissed atomically. DELETE is
  blocked at the policy level — breach records are themselves a
  compliance artifact.
- Unique constraint on `(tenantId, kind, actorUserId, windowStart)`
  gives the detector idempotency: re-running the scan within the
  same minute boundary converges on the same row instead of
  duplicating. Manual reports leave `actorUserId` and `windowStart`
  null, naturally skipping the constraint (PG NULL ≠ NULL semantics
  in unique indexes).
- New `BreachDetectorService.scan()` — v1 heuristic is
  **BURST_DECRYPT**: for each `(tenantId, actorUserId)` seen in the
  `data_access_event` ledger over the past `windowMinutes`, count
  distinct patient resourceIds that were decrypted. If the count
  exceeds 50 (configurable via `BURST_DECRYPT_PATIENT_THRESHOLD`),
  open a `severity='high'` incident tagged with the union of
  `fieldNames` from the events. Distinct-patients (not raw event
  count) is the right signal: one operator triaging a complex case
  may legitimately decrypt the same patient many times; touching
  many patients quickly is the suspicious pattern. The detector
  runs platform-wide in one pass (platform_admin role for the
  SELECT) and inserts per-tenant under the tenant role for the
  INSERT — so the RLS INSERT policy still gates writes correctly.
- New `BreachIncidentService` with five operations:
  - `fileManual()` — operator-filed `kind='MANUAL_REPORT'` (lost
    laptop, vendor breach, anything the heuristic doesn't catch).
  - `openAutoWithTx(tx, ...)` — detector-driven insert; returns
    `null` on the unique-constraint conflict so re-runs are a no-op.
  - `list(input)` — tenant-scoped, optional filters on
    `status` / `kind` / `from` / `to`, ordered by `openedAt desc`.
  - `findById()` + `renderNotificationPreview()` — view + show the
    rendered template before notifying.
  - `notify()` — flip `detected → notified`, snapshot the §8(6)
    template into `dpdpNotificationPayload`, stamp
    `dpdpNotificationSentAt`. Rejects when status isn't `detected`.
  - `dismiss()` — flip `detected → dismissed` with a required
    `reason` (DPDP audit trail needs the reason a potential
    breach was deemed not-reportable). Rejects when status isn't
    `detected`.
- New DPDP §8(6) notification template renderer at
  `apps/api/src/modules/breach/dpdp-notification-template.ts`. Pure
  function: takes the incident + tenant context and produces a
  `{subject, body, fields}` payload covering all six required
  Schedule II elements (description, approximate count of data
  principals, categories of data, likely consequences, mitigation
  measures, grievance officer contact). `BURST_DECRYPT` and
  `MANUAL_REPORT` get different stock copy for the consequences /
  mitigations sections. The 72-hour deadline is centralised as
  `DPDP_NOTIFICATION_WINDOW_MS = 72 * 60 * 60 * 1000` so the
  service + dashboard read from one source.
- New endpoints (`/breach-incidents`):
  - `POST /breach-incidents/scan` — manage; trigger detector pass.
  - `POST /breach-incidents` — manage; manual file.
  - `GET  /breach-incidents` — view; list (filter by status / kind / date).
  - `GET  /breach-incidents/:id` — view; row + rendered preview when
    status='detected', or the snapshotted payload when notified.
  - `POST /breach-incidents/:id/notify` — manage; flip + snapshot.
  - `POST /breach-incidents/:id/dismiss` — manage; flip with reason.
- New permissions: `breach_incident.view` + `breach_incident.manage`.
  Both granted to `platform_admin` and `tenant_admin` seed roles by
  default. Other roles (billing manager, insurance desk, reader)
  are intentionally excluded — incident records expose actor
  identity and the categories of personal data implicated.
- New audit events: `BREACH_INCIDENT_OPENED`,
  `BREACH_INCIDENT_NOTIFIED`, `BREACH_INCIDENT_DISMISSED`,
  `BREACH_DETECTOR_SCAN_COMPLETED`. All classified as governance
  (`retentionClass='governance'`, 8-year floor) so the compliance
  trail outlasts the incidents themselves.
- New CLI: `pnpm --filter @claims/api breach:scan`. Same shape as
  `audit:retention-sweep` — boots the Nest app, runs one
  `BreachDetectorService.scan()` pass, prints the structured result
  to stdout, exits. Production wiring is an external scheduler
  (k8s CronJob, cloud cron, pg_cron) on a 10–15 minute cadence for
  tight detection or hourly for steady state. Optional
  `--window-minutes=N` flag overrides the default 60-minute lookback.
- 8 e2e canary cases on `breach-incident.e2e-spec.ts`: detector
  raises BURST_DECRYPT when threshold exceeded; idempotent on
  re-run within the same minute; manual file lands MANUAL_REPORT
  with 72h `dpdpNotificationDueAt`; preview renders all six §8(6)
  sections; notify flips status + captures payload + rejects
  second notify; dismiss flips status with reason + rejects
  subsequent notify; viewer with `breach_incident.view` only is
  read-only (file/notify/dismiss → 403); reader with no breach
  permission can't list (403); cross-tenant GET → 422 (RLS canary).
- 6 unit tests on `dpdp-notification-template.spec.ts` lock the
  72h constant, the six §8(6) sections, the placeholder fallback
  for missing grievance contact, the kind-specific consequences /
  mitigations copy, and the structured-fields ISO round-trip.

### BR — DPDP §17 data access ledger + interceptor

- New append-only `data_access_event` table records every read of
  personal data (decryption of an encrypted PII field, bulk view
  of a PII-bearing list, audit-log query). Distinct from
  `audit_log` (which records state changes); this ledger records
  reads. DPDP Rules 2025 require operators to be able to answer
  "show me every time this patient's data was accessed". Rows
  carry `actorUserId`, `actorType`, `resourceType`, `resourceId`,
  `action`, `purpose`, optional `fieldNames` JSON, plus IP / UA /
  correlationId. Append-only at the RLS level (no UPDATE / DELETE
  policies); same tenant-scoped SELECT pattern as audit_log.
- New `DataAccessLogService` mirrors `AuditService` shape with
  `record()` (opens its own platform_admin transaction) and
  `recordWithTx()` (writes inside a caller's tenant tx).
- Two recording paths:
  - **Service-level decryption hook**: `PatientService.getDecrypted`
    now records an `action='decrypt'` event with a `fieldNames`
    list of the encrypted columns that were actually populated
    (`['aadhaar', 'mobile', ...]`). Optional `ctx` arg threads
    `actorUserId` + `purpose` + `correlationId` from the calling
    service; missing context falls back to `purpose='unspecified'`
    so coverage isn't lost during incremental rollout. Recording
    is best-effort and fire-and-forget — log failures must never
    break a decryption that orchestrators depend on.
  - **HTTP interceptor**: `@LogsPiiAccess({resourceType, action,
    purpose})` decorator on a controller method tags the handler;
    `PiiAccessInterceptor` (registered as `APP_INTERCEPTOR`) reads
    the metadata after the handler resolves successfully and
    writes a row tagging the actor + IP + UA. We log only on
    success — failed reads are audit_log territory. Applied on
    `AuditController.list` (purpose `audit_query`) and
    `AuditController.export` (purpose `audit_export`).
- 5 e2e canary cases on `data-access-event.e2e-spec.ts`:
  GET /audit emits a list event with the right purpose, GET
  /audit/export.csv emits an export event, `getDecrypted` records
  a decrypt event with field names from the explicit ctx,
  `getDecrypted` without ctx falls back to `purpose='unspecified'`,
  cross-tenant SELECT under tenant A's context returns no rows
  whose actor belongs to tenant B (RLS canary).

### BQ — DPDP §11 erasure-on-request

- New `erasure_request` table + `POST /erasure-requests` endpoint
  for honouring data principal erasure requests under DPDP Act 2023
  §11. Tenant-scoped, append-only at the RLS level (no UPDATE /
  DELETE policies), so every request commits with its final
  outcome and can't be edited later.
- Two terminal outcomes:
  - `completed` — patient PII redacted in-place. Encrypted ciphers
    + key versions + lookup hashes nulled (Aadhaar / ABHA /
    mobile / email / policy-number); plaintext fields scrubbed
    (fullName → `REDACTED-{6-digit-suffix}`, dateOfBirth → null,
    gender → null). Linked Case rows get `patientName` +
    `hospitalMrn` replaced with the same placeholder. The patient
    + case rows themselves stay because the linked Claim records
    carry IRDAI 5y / RBI 10y retention obligations against the
    now-redacted personal data.
  - `rejected` — DPDP §13 carve-out applies because one or more
    claims are still in non-terminal status. The response payload
    includes `rejectionReason.blockingClaims` listing each
    `{id, status}` so the operator can come back when the
    blocking claims close. "Erasable" statuses are `CLOSED`,
    `ABANDONED`, `WRITTEN_OFF` — broader than the state-machine's
    `TERMINAL_STATUSES` (CLOSED + ABANDONED only) because
    WRITTEN_OFF is functionally terminal for DPDP purposes.
- New permission `Permissions.ERASURE_PROCESS` (`erasure.process`).
  Seeded onto the two tenant-admin roles that already had
  `audit.view` (tenant_admin + billing_manager). Other roles are
  blocked with HTTP 403.
- New audit events `ERASURE_REQUEST_PROCESSED` +
  `ERASURE_REQUEST_REJECTED`, both classified as `governance` so
  the compliance audit trail outlasts the redacted personal data
  it documents. The classifier coverage test added in BO catches
  unclassified events at PR-time.
- 6 e2e canary cases: reader without permission → 403, no-claims
  patient → completed + PII scrubbed (verified by reading the
  patient + case rows back), patient with active PREAUTH_QUEUED
  claim → rejected + blockingClaims list + no redaction performed,
  patient with CLOSED claim → completed (closed claims don't
  block), cross-tenant GET on someone else's request id → 422
  (RLS canary), unknown patientId → 422.

### BP — Audit retention sweeper

- Postgres function `audit_retention_sweep(p_class TEXT, p_floor_days INT) RETURNS INT`
  deletes rows where `retentionClass = p_class AND occurredAt < now() - p_floor_days days`,
  returns the count. Rejects non-positive `p_floor_days` and empty
  `p_class` with a clear `RAISE EXCEPTION` so a misconfigured caller
  trips a hard error instead of silently deleting nothing.
- New RLS policy `audit_log_delete_retention` allows DELETE only when
  `app_current_role() = 'retention_sweeper'`. The existing
  `audit_log_no_delete USING(false)` policy continues to block every
  other role; both policies OR together at the row level so `tenant`
  and `platform_admin` callers still cannot delete audit rows. The
  new privileged role is set transactionally via `set_config('app.role',
  'retention_sweeper', true)` and never persists outside the sweep.
- `AuditRetentionSweeperService.sweepAll()` flips the role, iterates
  all six retention classes via the Postgres function in a single
  transaction, sums per-class counts, and emits a self-audit row
  (`action=AUDIT_RETENTION_SWEEP_COMPLETED`,
  `retentionClass=governance`) with the per-class counts + duration
  in the JSON `after` field. The self-audit row uses the zero-UUID
  tenantId sentinel because the sweep is platform-scoped, not
  tenant-scoped.
- `TenantRole` extended to include `retention_sweeper` (alongside
  `tenant` and `platform_admin`) so the privileged role is a
  first-class type and can't be passed by typo from arbitrary
  callers.
- Operator triggering: new CLI script invoked via
  `pnpm --filter @claims/api audit:retention-sweep`. Boots the
  NestJS application context (no HTTP listener), runs `sweepAll()`,
  prints a JSON summary, and exits. Wire to k8s CronJob / cloud
  cron / pg_cron for nightly cadence. We deliberately don't ship an
  in-app `@Cron` decorator — Redis is deferred and a naive
  `setInterval` would race across replicas and over-delete.
- 4 e2e canary cases: sweep deletes past-floor rows in each class
  while preserving recent rows; self-audit row carries the per-class
  counts; calling the function under the wrong role (e.g. `platform_admin`)
  silently deletes 0 rows (RLS gate works); the function rejects
  invalid `p_floor_days <= 0` and empty `p_class`.
- Self-audit event `AUDIT_RETENTION_SWEEP_COMPLETED` added to the
  `AuditEvents` enum and explicitly classified as `governance`. The
  classifier coverage test from BO is what would catch a future
  audit event being added without classification.

### BO — `audit_log.retentionClass` column + classifier + backfill

- Adds a stable semantic label to every `audit_log` row so BP's
  sweeper, BQ's erasure-on-request consent check, and BU's
  compliance dashboard can read from one column instead of
  re-deriving from the action string. Six classes, naming
  semantic-not-numeric so the year mapping can change without a
  schema migration:
  - `financial`  — RBI 10y. Settlement / payment / lending /
    monetary-impact decisions. Default fallback for unmapped
    actions (conservative — keep longer).
  - `clinical`   — IRDAI 5y. Claim/preauth/discharge transitions,
    doctor signatures, FHIR exchanges.
  - `security`   — DPDP/IRDAI 3y. Failed logins, account lock /
    unlock, password resets, MFA changes.
  - `session`    — DPDP transit, 90d. Login / logout / session
    revoked.
  - `governance` — 8y. Tenant lifecycle, NHCX cert rotations,
    role grants, invitations, user lifecycle.
  - `consent`    — 8y after withdrawal (BT will refine). DPDP
    consent records.
- New TS classifier at
  `apps/api/src/modules/audit/retention-classes.ts` maps every
  defined `AuditEvent` to a class. Coverage test asserts no
  current event silently hits the FINANCIAL fallback — adding a
  new event is a hard-fail on the spec until classified.
- Centralised `RETENTION_FLOOR_DAYS` map: `financial=3650`,
  `clinical=1825`, `security=1095`, `session=90`,
  `governance=2920`, `consent=2920`. BP reads from this; if
  DigiSparsh-lending slips out of v1, only this map needs to
  change to collapse `financial` to IRDAI 5y.
- Migration `20260524000000_audit_retention_class` adds the
  column with `NOT NULL DEFAULT 'financial'`, backfills existing
  rows by mapping action → class (mirrors the TS classifier),
  and adds a `(retentionClass, occurredAt)` index for BP's
  sweeper.
- `AuditService.recordWithTx` calls the classifier on every new
  write so the column is stamped at insert time.
- 21 unit cases on the classifier + taxonomy invariants
  (financial = longest, session = 90d, clinical = IRDAI 5y, etc.)
  + a 6-case e2e canary that asserts the column is stamped
  per-event by the service path AND the column-default kicks in
  for raw inserts skipping the column AND no fresh-DB row has a
  null/empty retentionClass.

## Sprint 7 — TBD (May 2026)

Theme settled mid-sprint: **PMJAY-via-NHCX is in v1**. Discovery
that PMJAY is migrating onto the same HCX 0.7.1 protocol surface we
already implemented (vs. the older "portal automation" framing in
`docs/07`) collapses the PMJAY sub-project from 4–8 weeks to ~8
slices. The v1 Sprint 7 axis runs PMJAY (BF–BM) + the EOB-OCR
inference service (separate Python repo) + earlier hardening
(BE deep-readiness already shipped). OVH KMS + Redis remain
deferred to production-rollout config swaps.

### BF — ABDM biometric authentication adapter

- New module `biometric-auth/` mirroring the EOB-OCR adapter pattern
  (off / stub / real factory). PMJAY mandates Aadhaar biometric
  / face / iris verification before preauth and before discharge or
  claim submission; this slice ships the adapter only — Slice BG
  will gate preauth + claim submit on it for PMJAY-mode tenants.
- Three adapters bound by `BIOMETRIC_AUTH_MODE`:
  - `off` (default) — `DisabledBiometricAuthAdapter`. Every call
    returns `{ status: 'disabled' }`. Non-PMJAY tenants and dev /
    test deployments take this path.
  - `stub` — `StubBiometricAuthAdapter`. Deterministic in-process
    pass with an env-driven failure list
    (`BIOMETRIC_AUTH_STUB_FAIL_LIST`) for negative-path tests.
    txnId / authToken / refreshToken issuance mimics the
    observable ABDM behaviour without an ABDM sandbox account.
  - `real` — `HttpBiometricAuthAdapter`. POSTs to
    `<BIOMETRIC_AUTH_BASE_URL>/hcx/abha/biometric/auth/{init,
    verify}`, GETs `/refresh/token`. Required headers
    (`authorization`, `process: Preauth | Discharge`,
    `payerid`) per the documented contract. Defensive parsing on
    every response so a sloppy upstream can't poison the gate.
- New env vars: `BIOMETRIC_AUTH_MODE` (off | stub | real, default
  off), `BIOMETRIC_AUTH_BASE_URL` (required when real),
  `BIOMETRIC_AUTH_HTTP_TIMEOUT_MS` (default 15s),
  `BIOMETRIC_AUTH_STUB_FAIL_LIST`. Boot-time config check rejects
  `real` mode without `BIOMETRIC_AUTH_BASE_URL` so a production
  deploy can't silently fall back to "every verify fails".
- 8 unit tests on the disabled + stub adapters cover happy path,
  fail-list rejection, replay protection, all three auth modes
  (FINGERPRINT / FACE_AUTH / IRIS), and refresh-token issuance.
  12 unit tests on the HTTP adapter against a `node:http` mock
  ABDM cover request shape (URLs, headers, JSON body), the
  one-PID-block-per-mode invariant, missing-`txnId` and
  missing-`token` paths, HTTP 401 / 500 errors, and connection
  refused.

### BN — PMJAY participant onboarding CLI

- One-shot per-hospital CLI at
  `apps/api/src/scripts/pmjay-onboard/`. Drives the four-step PMJAY
  participant flow:
  1. `participant/create` → SMS OTP issued.
  2. `validate?transactionId&passcode` → status PENDING → ACTIVE.
  3. `participant/update` (with public key + endpoint URL) → new
     SMS OTP, 24h TTL.
  4. `update/validate?transactionId&passcode` → certificate
     registered, endpoint live, status fully ACTIVE.
- State (participantid + both transactionids + key paths) persists
  to a JSON file the operator passes via `--state-file`. The
  step-3 OTP can land 24 hours later, so resume between runs is a
  first-class flow: `--resume` re-enters the saved step. State
  written with mode 0600 on POSIX (best-effort no-op on Windows).
- Generates a 2048-bit RSA keypair locally if one isn't already at
  the configured path prefix (writes `*.private.pem` 0600 +
  `*.public.pem` 0644). Public key is base64(pem-text) for
  `encryptioncert`. Refuses to clobber a single pre-existing file
  to protect operator-generated keys.
- Run via `pnpm --filter @claims/api pmjay:onboard --base-url
  https://apisbx.abdm.gov.in/pmjay/sbxhcx/participanthcxservice/v2/`
  and similar for production. All inputs (registry id, mobile,
  email, endpoint URL) are prompted interactively; flags supply
  them non-interactively for scripted runs.
- Three test files (20 total cases): HTTP client coverage on URL
  composition, bearer header, query-param encoding for OTP
  validates, Zod input validation, error envelope handling, and
  non-JSON response capture; state file round-trip + corruption
  rejection + resume; keypair generation, idempotency on existing
  files, refusal to clobber a half-existing pair, and base64-PEM
  serialisation.
- Source contract: `HIMS-PMJAY suppporting docs/PMJAY Hospital
  Migration to HMIS via NHCX.docx` §3.1–3.4 (authoritative payload
  shapes), `NHCX-PMJAY-HMIS Integration Guide (1).pdf` §1.7
  (sandbox prerequisites), `NHCX PMJAY Integration Handbook.docx`
  §5.5.2 (host pattern). After step 4, the operator must raise an
  NHA ticket to map PMJAY Hospital ID (HEM ID) ↔ NHCX Participant
  ID — that's the manual go-live trigger and is out of scope for
  the CLI.

### BM — FHIR code-system whitelist (PMJAY-aware)

- New pure validator at `apps/api/src/modules/nhcx/fhir-validator/`.
  Walks an inbound (or outbound) FHIR Bundle, collects every unique
  `coding.system` and `identifier.system` URI, and classifies them
  against four buckets:
  - `universal` — HL7 / FHIR R4 terminology shared across rails
    (e.g. `terminology.hl7.org/CodeSystem/v2-0203`,
    `hl7.org/fhir/sid/icd-10`).
  - `nhcx` — ABDM + NDHM core registries (HPR, ABHA, facility) plus
    DigiSparsh-internal identifiers (`urn:digisparsh:*`).
  - `pmjay` — PMJAY-specific systems documented in
    `HIMS-PMJAY suppporting docs/FHIR_bundles_PMJAY_ext/`:
    `payer.pmjay.nha.gov.in` (package + diagnosis codes),
    `payer.pmjay.nha.gov.in/CodeSystem/task-{operation,reason}`
    (Slices BH/BI), `hcx.pmjay.gov.in/v1/{coverageeligibility/check,
    preauthorization, claim}`, `bis.pmjay.gov.in`,
    `provider.pmjay.gov.in`, `payer.nha.gov.in`,
    `nhcx.pmjay.gov.in`.
  - `unknown` — anything not in the above three sets.
- Identifier-type code detection: under
  `nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-identifier-type-code`, we
  recognise `PMJAY`, `HPID`, `HPIN`, `JHN`, `PI`, `NPI`, `NIIP`,
  `NH`. The validator surfaces a `usesPmjayIdentifierType` boolean
  for cross-checks and lists any unknown codes under that system.
- Wired into `NhcxInboundService.process()` after JWE decryption.
  When the validator finds anything (unknown systems, unknown
  identifier-type codes, or PMJAY systems on a non-PMJAY-mode
  tenant — likely a misrouted callback), the dispatcher emits a
  structured warning carrying correlationId + tenantId. Non-blocking
  in v1: the gateway evolves faster than our whitelist could, and
  rejecting callbacks would hold up legitimate traffic. The
  signal is for ops triage.
- 10 unit cases on the validator: standard NHCX bundle classifies
  cleanly with no unknowns, real-shape PMJAY bundle (mirroring
  `coveragerequest_benefits.txt` from the supporting docs) hits
  all three whitelist buckets and detects the PMJAY identifier
  type, unknown payer systems land in `unknown`, unknown
  identifier-type codes under the NDHM system surface, codes under
  non-NDHM systems are NOT mis-classified, non-object inputs
  return empty results, and `summariseFindings` returns null on
  the happy path / surfaces misroute warning / lists unknowns.

### BL — PMJAY drop Communication-based query response (re-submit instead)

- PMJAY tenants don't respond to payer queries via FHIR Communication;
  the documented workflow is to pull the preauth (or claim) back to
  drafting, fix whatever the payer asked about, and re-submit. We
  reject the existing Communication-based response endpoint for PMJAY
  callers with HTTP 422 and a tenant-field error that points the
  operator at the new resubmit route.
- Two new endpoints, both PMJAY-only at the service gate:
  - `POST /cases/:caseId/claims/:claimId/preauth/resubmit` — flips
    `PREAUTH_QUERY_RAISED → preauth.resubmission_started → PREAUTH_DRAFTING`
    via a new state-machine transition. Outstanding `preauth_query`
    rows on the claim are stamped with `responseText='[resubmit] ...'`
    and `respondedAt=now()` so the audit trail captures *why* the
    operator pulled back to drafting (informational; the state
    transition is what closes the query window).
  - `POST /cases/:caseId/claims/:claimId/claim-submission/resubmit`
    — mirror of the preauth flow on the claim side. Flips
    `CLAIM_QUERY_RAISED → claim.resubmission_started → CLAIM_DRAFTING`.
- Both routes are state-only flips — no NHCX outbound. The next
  `preauth/submit` (or `claim-submission/submit`) is what reaches
  the gateway.
- New permissions / events:
  - `Permissions.CLAIM_RESPOND_QUERY` (mirror of the existing
    `PREAUTH_RESPOND_QUERY`) for the claim resubmit route. Seeded
    onto the four PMJAY-active roles in `prisma/seed.ts`. The
    preauth resubmit route reuses `PREAUTH_RESPOND_QUERY` because
    it's a query-resolution gesture.
  - Two new claim events: `preauth.resubmission_started`,
    `claim.resubmission_started`. New transitions are
    `from`-restricted to the QUERY_RAISED states; the state-machine
    spec asserts non-QUERY_RAISED inputs are refused.
- 4 unit cases added to `claim.state-machine.spec.ts` covering the
  new transitions + their refusal from non-QUERY_RAISED states.
  6 e2e cases on `pmjay-resubmit-on-query.e2e-spec.ts`: PMJAY
  Communication-respond rejected, PMJAY preauth resubmit happy path
  (with `preauth_query` stamp assertion), non-PMJAY preauth resubmit
  rejected, PMJAY claim resubmit happy path, non-PMJAY claim
  resubmit rejected, PMJAY resubmit from non-QUERY_RAISED → 422.

### BK — PMJAY eligibility three-purpose dispatch

- PMJAY-via-NHCX runs `coverageeligibility/check` three times per
  case, each with a different FHIR `CoverageEligibilityRequest.purpose`
  value: `validation` (post-registration / wallet check),
  `benefits` (before preauth, to confirm coverage limits), and
  `auth-requirements` (before submission, to fetch the document
  checklist). Reference bundles are in
  `HIMS-PMJAY suppporting docs/FHIR_bundles_PMJAY_ext/coverageeligibility/`.
- New `purpose` field on `EligibilityRequestSchema` (zod enum:
  `validation | benefits | auth-requirements`). Optional at the
  schema level for backwards-compatibility with the existing private-
  rail callers, but **required for PMJAY tenants** — the eligibility
  service rejects a missing purpose with HTTP 422 when
  `tenant.pmjayMode === 'on'`.
- `buildEligibilityRequestBundle` now accepts a single-element
  purpose; when set it emits `purpose: [purpose]`, when omitted it
  falls back to the legacy combined `['benefits', 'validation']`.
  Adapter interface gains `AdapterEligibilityPurpose` +
  `purpose?: ...` on `AdapterEligibilityRequest`. Stub adapter
  echoes purpose into the inbound `rawResponse` so integration
  tests can assert the correct dispatch landed. JWE adapter
  forwards purpose to the builder.
- New eligibility request payload field is the only API surface
  change. No new permission, no migration. The PMJAY purpose is
  also stamped on the `eligibility.requested` claim event payload
  so the audit ledger distinguishes the three calls.
- 4 unit tests on the FHIR builder verify the four purpose
  variants (legacy + 3 single-purpose values). 6 e2e cases on
  `/cases/:caseId/claims/:claimId/eligibility`: PMJAY missing
  purpose → 422 with field-targeted error from the gate, PMJAY
  with each of the three purposes → 200 + ledger echo, PMJAY
  with a bogus purpose value (FHIR `discovery`, not in our enum)
  → 422 from Zod, non-PMJAY tenant + omitted purpose → 200
  legacy path with no purpose echo.

### BJ — PMJAY beneficiary policies lookup (`/participant/get/policies`)

- New endpoint `POST /pmjay/policies/lookup` — pre-eligibility step
  where the operator enters an ABHA / mobile and the API returns
  the matching PMJAY policies the beneficiary is enrolled in. The
  operator picks one to attach to the case before running
  eligibility.
- Identifier types per the PMJAY supporting docs: ABHA (14 digits,
  no hyphens) and mobile (10 digits). Aadhaar is intentionally NOT
  supported — PMJAY's API requires ABHA / mobile linkage at
  registration; the docs are silent on Aadhaar.
- Per-policy fields sourced from NHCX PMJAY Integration Handbook
  §5.6: `payerId`, `memberId`, `productId`, `productName`,
  `policyNumber`. Optional fields like `sumInsured`, `state`,
  `status` aren't documented and aren't surfaced by the adapter
  yet — extend defensively when the upstream response is observed.
- New `NhcxAdapter.lookupPmjayPolicies` on the interface + stub.
  JWE real-mode is **deferred**: the upstream sandbox/prod URL for
  `/participant/get/policies` isn't published in the supporting
  docs, and per §5.6 this endpoint is plain-REST + bearer-auth
  (NOT JWE-wrapped) so it doesn't fit `callOperation`'s envelope.
  JWE adapter throws a clear "real-mode not yet implemented" error
  pointing at the §5.6 reference; ops must run `NHCX_MODE=stub`
  for now.
- Stub adapter: deterministic fixtures keyed off the identifier:
  - non-sentinel → one PMJAY Rajasthan policy with values derived
    from the last 6 chars of the identifier
  - `STUB-EMPTY-*` → empty `policies` array (beneficiary not linked)
  - `STUB-MULTI-*` → two policies on different products
- New module `pmjay-policies/` with thin `PmjayPoliciesService`
  (tenant gate → adapter pass-through; no persistence). PMJAY-only
  — non-PMJAY tenants get 422 `tenant: ['PMJAY policies lookup is
  currently a PMJAY-only operation.']`.
- Permission: reuses `PREAUTH_DRAFT` rather than introducing a new
  permission. Every operator who can start a preauth needs to be
  able to look up the beneficiary's policy; a dedicated permission
  is a future split if the desks separate.
- Tests:
  - 4 unit cases on the stub adapter (single, empty, multi, echo)
  - 3 unit cases on `PmjayPoliciesService` (PMJAY pass-through,
    non-PMJAY rejection, unknown-tenant rejection)
  - 5 e2e cases: PMJAY ABHA lookup, mobile lookup, non-PMJAY
    rejection, malformed ABHA → 422 from Zod, malformed mobile →
    422 from Zod

### BI — PMJAY claim reprocess (CRC) via outbound `task/submit`

- Mirror of Slice BH on the claim side: outbound `task/submit` with
  PMJAY's `code: 'reprocess'` shape, used for the Claim Re-Consideration
  flow. Two reason codes per the PMJAY supporting docs:
  `claimrejected` (re-evaluate a CLAIM_REJECTED claim) and
  `partialpayment` (re-evaluate a SHORT_PAID settlement).
- New `NhcxAdapter.reprocessClaim` on the interface + stub + JWE.
- New `buildTaskReprocessBundle` FHIR builder with two
  `Task.input[]` entries: ClaimNumber → claimRefNum, plus a
  ReasonCode coding on the PMJAY task-reason code system.
  `Task.status='requested'` (vs cancel's 'cancelled') because the
  hospital is asking the payer to act, not asserting a state on
  their behalf.
- New `CLAIM_REPROCESS_REQUESTED` status + `claim.reprocess_requested`
  event. Transitions:
  - `CLAIM_REJECTED → claim.reprocess_requested → CLAIM_REPROCESS_REQUESTED`
  - `SHORT_PAID → claim.reprocess_requested → CLAIM_REPROCESS_REQUESTED`
  - From CLAIM_REPROCESS_REQUESTED, the existing decision events
    (claim.approved / .rejected / .partially_approved /
    .query_received) re-decide via the inbound `claim/on_submit`
    dispatcher.
- New `CLAIM_REPROCESS` permission + seed update — granted to
  every role that already has `claim.submit` (tenant_admin,
  billing_manager, insurance_desk_executive, pmam).
- New endpoint
  `POST /cases/:caseId/claims/:claimId/claim-submission/reprocess`
  with body `{ reasonCode: 'claimrejected' | 'partialpayment',
  reason?: string }`. Returns `{ status, correlationId }`. Service
  guards:
  - Tenant must be `pmjayMode='on'` → 422
    `tenant: ['Claim reprocess is currently a PMJAY-only operation.']`
  - Claim must have a `claimRefNum` → 422
    `claimRefNum: ['Reprocess requires a claim reference issued
    by the payer.']`
  - reasonCode/status must align: `claimrejected` requires
    CLAIM_REJECTED; `partialpayment` requires SHORT_PAID. → 422
    with field-targeted message naming the current status.
- Tests:
  - 5 new unit cases on `buildTaskReprocessBundle` (bundle shape,
    Task.status='requested' + code, two-input invariant
    [ClaimNumber + ReasonCode], reason display strings, note flow).
  - 3 e2e cases: PMJAY happy-path reprocess from CLAIM_REJECTED
    (walks the full preauth → discharge → claim flow with BG
    biometric), non-PMJAY rejection at tenant gate,
    reasonCode/status mismatch rejection.

### BH — PMJAY preauth cancel via outbound `task/submit`

- New `cancelPreauth` method on `NhcxAdapter` (stub + JWE) for the
  PMJAY-specific `task/submit` outbound with `code: 'cancel'` and
  `inputType: 'ClaimNumber'`. Hospital-asserted cancellation; the
  payer's ack arrives later via the existing `task/on_submit`
  inbound handler (Slice BD already records that branch).
- New FHIR `Task` bundle builder (`buildTaskCancelBundle`)
  materialises the wire shape per the PMJAY supporting docs:
  `Task.status='cancelled'`, `Task.code` carries the cancel coding
  on the PMJAY task-operation code system,
  `Task.input[]` carries `(ClaimNumber, preauthRefNum)`, optional
  operator reason flows into `Task.note[].text` for the payer's
  audit trail.
- New `PREAUTH_CANCELLED` status + `preauth.cancelled` event +
  transitions from `PREAUTH_QUEUED`, `PREAUTH_SUBMITTED`,
  `PREAUTH_QUERY_RAISED`, `PREAUTH_QUERY_RESPONDED`. Terminal-ish:
  only further transition is `case.abandoned → ABANDONED`.
- New `PREAUTH_CANCEL` permission + seed update — granted to
  `tenant_admin`, `billing_manager`, `insurance_desk_executive`,
  and `pmam` roles (every role with `preauth.submit`).
- New endpoint `POST /cases/:caseId/claims/:claimId/preauth/cancel`
  with Zod-validated `{ reason?: string }` body. Returns
  `{ status, correlationId }`. Service-level guards:
  - Tenant must be `pmjayMode='on'` — otherwise 422 with
    `tenant: ['Preauth cancel is currently a PMJAY-only operation.']`.
    PMJAY-only because the operation is part of the PMJAY API
    surface; non-PMJAY tenants don't have defined cancel semantics
    in HCX 0.7.1 yet.
  - Claim must have a `preauthRefNum` (the gateway-issued reference
    used as `Task.input[].valueIdentifier.value`) — otherwise 422
    with `preauthRefNum: ['Cancel requires a preauth reference
    issued by the payer.']`.
- Tests:
  - 5 new unit cases on `buildTaskCancelBundle`: bundle shape, Task
    status + code, input ClaimNumber wiring, reason → note,
    note omission when reason undefined.
  - 3 e2e cases: PMJAY happy-path cancel from PREAUTH_SUBMITTED
    (uses BG biometric flow + BF stub), non-PMJAY rejection at the
    tenant gate, no-preauthRefNum rejection.

### BG — PMJAY biometric gate on preauth + claim submit

- New `tenant.pmjayMode` column (`'on' | 'off'`, default `'off'`).
  Tenants in PMJAY-mode are gated on a recent ABDM biometric
  verification before preauth submit (process `Preauth`) and before
  claim submit (process `Discharge`). Non-PMJAY tenants are
  unaffected — no gate, no extra latency.
- New `biometric_verification` table records each successful ABDM
  verification with the originating ABDM `txnId`, hashed `loginId`
  (sha256 — raw ABHA / Aadhaar / mobile is never persisted),
  `process`, `authMode`, and a verifiedAt + expiresAt window
  (`BIOMETRIC_VERIFICATION_TTL_MINUTES`, default 60). Same
  RLS pattern as `appeal` and other tenant-scoped tables.
- New endpoints under `cases/:caseId/biometric-auth/`:
  - `POST /init` — proxies the ABDM `init` call, returns the
    `txnId` for the verify step. Doesn't write a row.
  - `POST /verify` — proxies `verify`, persists a row on
    success, enforces "exactly one PID block per authMode" before
    calling the adapter (saves a network round-trip on operator
    miswiring).
- New `BiometricAuthService.assertVerifiedFor(caseId, process)`
  helper invoked from `PreauthService.submit` and
  `ClaimSubmitService.submit` only when `tenant.pmjayMode === 'on'`.
  Throws `BiometricVerificationRequiredError` (HTTP 412 →
  `BIOMETRIC_VERIFICATION_REQUIRED`) when no non-expired row
  matches the `(caseId, process)` pair. Frontend bounces the
  operator to capture biometric and retry.
- Two new error codes: `BIOMETRIC_VERIFICATION_REQUIRED` (412 — gate
  miss) and `BIOMETRIC_VERIFICATION_FAILED` (422 — adapter
  rejected the device PID, network error, etc.). Both wired into
  `ErrorPresentations` with operator-friendly modal copy.
- 5-case end-to-end integration test:
  1. Non-PMJAY tenant submits preauth without biometric → 200
     (regression — gate must be invisible to non-PMJAY tenants).
  2. PMJAY tenant submits preauth without biometric → 412.
  3. PMJAY tenant: init → verify writes row → submit → 200.
  4. Verify rejects authMode/PID mismatch → 422.
  5. Init surfaces stub adapter failure → 422.
- We deliberately do NOT store the ABHA `authToken` /
  `refreshToken` in this slice — BG only needs the gate. Encrypted
  token storage + FHIR Bundle binding lands in a follow-up slice.

### BE — `/health/ready/deep` deep-readiness probe

- New endpoint `GET /health/ready/deep` extends the cheap `/ready`
  shape with a `deep` block that runs adapter-level probes against
  ClamAV (clamd zPING/PONG over TCP) and the EOB-OCR inference
  service (HEAD over HTTP). Each probe returns
  `{ status: 'ok' | 'skipped' | 'failed', reason?, latencyMs? }`.
- Probes run in parallel under a 2s ceiling each so the response
  stays bounded even when one dependency is wedged. `skipped` is
  the right answer for dev/test deployments where the adapter is
  in `off` or `stub` mode — we don't want a degraded LB drain
  because clamd isn't deployed locally.
- Overall `status` collapses to `degraded` if either the cheap
  `/ready` was already degraded *or* a deep probe failed, so
  ops dashboards get one signal to watch.
- Don't wire this onto the load balancer's probe path —
  `/ready` stays the cheap one. `/ready/deep` is for ops
  dashboards + manual-triggered diagnostics.
- 10 unit tests against `node:net` mock clamd + `node:http`
  mock OCR servers cover off/skip, real+healthy, abrupt close,
  missing endpoint, connection refused, alive 4xx (405 from
  inference services on HEAD `/` is treated as alive), 503
  failure, missing URL, both-parallel-ok.

## Sprint 6 — TBD (May 2026)

Theme not yet committed; sprint axis pending the user's call (see
`docs/sprint-5-exit.md` open questions). First slice is a follow-on
to the AO signature guard from Sprint 5.

### BD — `insuranceplan/on_request` + `task/on_submit` inbound types (PR #63)

- Completes the HCX 0.7.1 inbound protocol surface. The Sprint 4
  exit doc deferred these on the basis of "no operational
  pressure"; BD records them in the integration_message ledger so
  CLAUDE.md hard-rule #7 (every external integration call writes
  both directions) is fully satisfied. State transitions stay
  out of scope until the ops use cases are real.
- New `parseInsurancePlan` extracts `{ planId?, name?, status?,
  type? }` defensively — pulls the first non-empty
  `identifier[].value`, the FHIR-canonical `type[0].coding[0].code`,
  status pass-through.
- New `parseTask` extracts `{ status?, description?, focusRef? }`.
  `focusRef` reads `focus.reference` first, falls back to
  `focus.identifier.value`.
- Inbound dispatcher branches are log-only: parse, log a one-line
  ops summary, attach the parsed shape to the integration_message
  `rawResponse` summary. No claim service touched.
- 8 unit tests cover happy + missing-field + missing-resource +
  identifier-list fallback shapes for both parsers.
- 2 integration tests against an in-process JWE confirm: end-to-
  end accept + parse + record succeeded, no claim status change.

### BC — `paymentnotice/request` inbound handler (PR #62)

- New NHCX inbound message type. The gateway pushes a
  PaymentNotice when the payer settles a previously-submitted
  claim; the dispatcher routes it through
  `SettlementService.recordReceipt` so the claim auto-flips to
  PAYMENT_RECEIVED (or SHORT_PAID) without operator action.
- `paymentnotice/request` added to `NhcxInboundOperationSchema`.
  Tenant + claim resolution reuses the existing matching-outbound
  pattern (the gateway echoes the original `claim/on_submit`
  correlationId), so no cross-tenant lookup is needed.
- New `parsePaymentNotice` FHIR helper extracts
  `{ kind, receivedAmount, receivedAt?, bankTxnId?, claimRefNum? }`
  defensively. `bankTxnId` reads from either the top-level
  `identifier` (Mediassist / Star) or the nested
  `request.identifier` (Paramount). Cancelled / unknown notices
  log + skip without driving a transition.
- `RecordReceiptInput.actorUserId` is now `string | null` —
  matches the existing `claim_event.actorUserId` nullability so
  gateway-driven calls write a row with no operator attached.
  All existing operator-triggered call sites pass a string and
  type-check unchanged.
- 8 unit tests on the parser + 3 integration tests against an
  in-process JWE: full payment → PAYMENT_RECEIVED + bankTxnId
  on Settlement; short payment → SHORT_PAID; cancelled notice
  recorded but no transition driven.

### BB — Reconcile UI with deduction lines (PR #61)

- Reconcile branch on `PAYMENT_RECEIVED` was a single "Reconcile
  (auto-match)" button with no way to capture the structured
  deduction lines the API has accepted since Slice N. BB exposes
  an Add line button that stamps a `{ category, amount, reason }`
  row, with Remove next to each line.
- Auto-fill from the AY EOB extraction. When the operator runs
  Extract earlier (typically at `PAYMENT_PENDING`), any
  deductions in the result land in component state and pre-fill
  the rows once the claim transitions to `PAYMENT_RECEIVED`.
  The component stays mounted across the status change, so the
  state carries through without a fetch round-trip.
- Empty rows are dropped at submit (the operator can leave a
  half-edited row without sending an empty `{ category: '',
  amount: 0 }` to the API).
- Operator copy for the no-deductions case clarifies the auto-
  match semantics: reconciling with an empty deductions array
  records the payment as fully received.
- New `DeductionRow` helper component split out of the panel for
  the editable line; `ExtractSummary` is unchanged.

### BA — Settlement screen: extract-and-apply polish (PR #60)

- AY pre-filled `receivedAmount`. BA extends to `bankTxnId` and
  `shortPaymentReasons` so the operator can apply the full set of
  receipt-relevant fields the OCR found, not just the headline
  amount. The receipt form on `PAYMENT_PENDING` now exposes those
  three fields in a labelled grid; comma-split happens at submit
  so the operator can edit the list inline.
- AZ's download URL is wired into the EOB dropdown as a **View**
  button. Clicking it fetches a fresh presigned URL and opens the
  document in a new tab — operators can verify what the OCR is
  reading off without leaving the settlement screen.
- New `CaseApi.getDocumentDownloadUrl(caseId, claimId, documentId,
  filename?)` web client helper. Each call gets a fresh URL
  (presign expiry is short by design).
- `recordReceipt` call now forwards `bankTxnId` and
  `shortPaymentReasons` whenever they're non-empty; `bankTxnId`
  lands on the `Settlement` row (Slice AN persistence) so finance
  can reconcile back to the bank.

### AZ — Presigned document download URL (PR #59)

- New `GET /cases/:c/claims/:cl/documents/:id/download-url` returns
  a short-lived presigned GET URL the browser hits direct from S3.
  Operators can finally view what they uploaded — pre-req for the
  AY EOB-extract UX (you have to trust what the OCR is reading).
- `StorageAdapter` gains `presignDownload({ bucket, key,
  downloadFilename? })`. S3 impl uses `GetObjectCommand` +
  `ResponseContentDisposition` so the optional override binds to
  the SigV4 signature (a tampered URL won't change the
  download-as filename). Stub mode synthesises a `stub://` URL —
  tests use it to confirm wire-up without standing up MinIO.
- Same scope guards as the AW eob-extract endpoint: document
  belongs to (tenant, claim), upload completed, scan clean/skipped.
  Anything else 422 — we don't hand out URLs to infected or
  pending uploads. RBAC is `case.view` (anyone who can see the
  case can download its documents).
- `?filename=` query override sanitises CR/LF/`"` (the Content-
  Disposition quoted-string set) but lets unicode pass through.
- 3 integration tests against the stub storage path: happy path
  returns `stub://`, cross-claim → 422, filename override
  doesn't crash the request. Plus a stub-storage unit test for
  the URL synthesis.

### AY — EOB extract on the settlement screen (PR #58)

- Wires the AW endpoint into `SettlementPanel.tsx`. When the claim
  is at `PAYMENT_PENDING`, the panel now lists the claim's
  EOB-typed completed documents in a dropdown, exposes an
  "Extract" button, and pre-fills `receivedAmount` from the
  result.
- A coloured `ExtractSummary` block under the dropdown surfaces
  the extraction status (`extracted` / `low_confidence` / `failed`
  / `skipped`), the engine, and a deconstructed view of the
  fields (claimRefNum, receivedAmount, deductionAmount, bankTxnId,
  deductions) so the operator can sanity-check before clicking
  Record receipt.
- New `CaseApi.eobExtract(caseId, claimId, documentId, body)`
  client helper. Body is optional; the inline-buffer path is for
  the eventual operator UX where they re-attach the EOB on the
  fly. Default flow expects the API to fetch from S3 (real
  storage) — under stub storage the response surfaces as
  `skipped` and the operator types the values manually, exactly
  as before.
- No new tests at the web layer; the contract path is already
  covered by AW's API integration tests + AV's adapter unit tests.

### AX — Real EOB OCR adapter via HTTP inference service (PR #57)

- Closes the `EOB_OCR_MODE='real'` placeholder. The new
  `HttpEobOcrAdapter` POSTs document bytes as `multipart/form-data`
  to `<EOB_OCR_INFERENCE_URL>/extract` with optional bearer auth
  and parses the JSON response into the existing `ExtractResult`
  contract.
- The inference service is third-party from our perspective —
  any service that accepts `(file, contentType, filename)` as
  multipart and returns `{ status, engine, fields?, error? }`
  works. The reference implementation is a Python service wrapping
  PaddleOCR / Surya for OCR + Qwen2-VL / GOT-OCR2.0 for the
  structured-fields pass; the contract is compatible with custom
  per-tenant or per-payer extractors operators may stand up.
- Defensive response parsing — sloppy upstream output (wrong
  status, missing fields, bad numeric coercion) surfaces as
  `failed` rather than poisoning downstream persistence. Each
  field is type-checked individually; nothing flows through
  unvalidated.
- Storage-streaming path mirrors `ClamAvScanAdapter` (Slice AS):
  when only `(bucket, key)` is supplied, the adapter pulls bytes
  via `StorageAdapter.getObject`. Stub storage throws — caller
  sees `failed` with a clear "Failed to fetch object" reason.
- Boot-time config gate: `EOB_OCR_MODE=real` requires
  `EOB_OCR_INFERENCE_URL`. `EOB_OCR_HTTP_TIMEOUT_MS` defaults to
  60s (local Qwen2-VL on CPU can run ~10–30s per page). Optional
  `EOB_OCR_API_KEY` for self-hosted setups behind bearer auth.
- 12 unit tests against a `node:http` mock server cover request
  shape (POST /extract, multipart body, bearer header, body
  bytes embedded), happy paths (`extracted` / `low_confidence`),
  failure modes (non-2xx, malformed JSON, invalid status,
  missing fields, timeout, missing config, connection refused),
  trailing-slash stripping, and the AS-style storage-fetch path
  with both success and getObject-throws cases.

### AW — `POST /documents/:id/eob-extract` endpoint (PR #56)

- Wires the AV `EobOcrAdapter` to an HTTP surface so the settlement
  screen can pull extracted fields on demand. Lives at
  `POST /cases/:caseId/claims/:claimId/documents/:documentId/eob-extract`,
  scoped under the existing case/claim path so RBAC reuses
  `case.create` (the role that uploaded the EOB extracts its
  fields).
- `bufferBase64` request field is optional. Provided: the adapter
  scans those bytes directly (matches the existing
  `UploadFinalizeRequest.scanBufferBase64` pattern, useful in
  stub-storage tests + cases where the client still has the buffer
  cached). Omitted: the adapter is expected to fetch the bytes
  from storage by `(bucket, key)` — works in real storage,
  surfaces `skipped` (stub adapter) or `failed` (real adapter
  against stub storage) per the AS pattern.
- Pre-conditions: document belongs to (tenant, claim), upload is
  completed, scan is `clean` or `skipped`. Anything else is a 422 —
  running OCR against a pending / infected upload would either hit
  empty bytes or scan-quarantined bytes.
- Response shape `EobExtractResponse` mirrors `ExtractResult`:
  status (`extracted | low_confidence | skipped | failed`), engine,
  optional fields, optional error.
- Operators trigger the call explicitly rather than auto-running at
  finalize so a heavy real-OCR call doesn't slow the upload-finalize
  path.
- 4 integration tests: short-paid sentinel → extracted with
  deduction line, clean sentinel → no deductions, no buffer + stub
  storage → skipped (forgot-to-attach UX), cross-claim documentId
  → 422.

### AV — EOB OCR adapter skeleton (PR #55)

- New `EobOcrModule` global module with the same shape as
  `VirusScanModule`: a sealed `EobOcrAdapter` interface +
  `EOB_OCR_MODE` env switch (`off` | `stub` | `real`) + a factory
  provider that picks the right implementation. `real` is reserved
  for the OSS pipeline (PaddleOCR / Surya for OCR + Qwen2-VL /
  GOT-OCR2.0 for structured field extraction); the factory falls
  back to disabled with a warning if anyone flips the env early so
  a deploy tier doesn't crash on boot.
- `ExtractedEob` shape lines up with the existing Settlement
  contract: `claimRefNum`, `receivedAmount`, `deductionAmount`,
  `deductions[]`, `shortPaymentReasons[]`, optional `bankTxnId` /
  `receivedAt`. Per-field `confidence` (0–1) accompanies the values
  so the eventual settlement screen can badge auto-extracted fields
  for operator review. Result statuses: `extracted` | `low_confidence`
  | `skipped` | `failed`.
- Stub adapter recognises three sentinel patterns —
  `STUB-EOB-CLEAN-<refnum>-<amount>`, `STUB-EOB-SHORT-<refnum>-
  <received>-<expected>`, `STUB-EOB-FAIL` — so integration tests
  can exercise extracted/failed/low-confidence paths without an
  OCR engine running. `STUB_EOB_SENTINELS` is the public format
  helper for fixture authors.
- 8 unit tests on the adapters cover the sentinel patterns + the
  bucket/key bypass + the noise-tolerance regex anchor + the
  STUB_EOB_SENTINELS round-trip contract.
- No service or controller wiring yet — the next slice will hook the
  adapter into the document scan/finalize pipeline so EOB-typed
  documents get auto-extracted into a draft Settlement form on the
  operator screen.

### AU — Real-clamd integration test (PR #54)

- Closes the validation gap from AQ + AS. The unit suite
  (`clamav-scan.adapter.spec`) proves the adapter speaks INSTREAM
  correctly against a wire-format-faithful `node:net` mock; this
  slice proves the same code talks to a real clamd, picking up any
  drift between our reading of the protocol and clamd's behaviour
  (signature names, edge-case framing, version skew).
- New `apps/api/test/setup/clamav-container.ts` — testcontainers
  helper for `clamav/clamav:1.4` (full image so signatures are
  preloaded and EICAR is detected from the first request).
  Wait-strategy matches any of clamd's "started" / "Listening
  daemon" log lines; 180s startup deadline absorbs cold-cache image
  pulls + signature-DB load on a fresh CI runner.
- New `clamav-real.e2e-spec.ts` runs the `ClamAvScanAdapter`
  directly (no AppModule, no Postgres, no MinIO — only the clamd
  container) against three cases: clean buffer is clean; EICAR
  buffer surfaces `infected` with a non-empty signature (signature
  text varies between `Eicar-Signature` / `Win.Test.EICAR_HDB-1`
  depending on the bundled DB, so we assert non-empty rather than
  exact match); S3-streaming path (Slice AS) routes through a mock
  storage adapter's `getObject` and EICAR is detected on the
  fetched bytes.
- Test timeout is 240s — covers the worst-case cold-runner image
  pull + the three scans inside.

### AT — Inbound rate limit on `/nhcx/inbound` (PR #53)

- Adds `NhcxInboundRateLimitGuard` after the AO signature guard:
  unauthenticated floods are 401'd before they touch the rate counter;
  authenticated floods get throttled to 429.
- Fixed-window counter in-memory, scoped to the controller (the
  whole gateway shows up as a single egress IP from our side, so
  per-IP would have the same shape). Single-replica only — a
  distributed limit needs Redis and lands with the deferred BullMQ
  slice that already touches Redis surface.
- Env: `NHCX_INBOUND_RATE_LIMIT_PER_MINUTE` (default 60 — covers
  expected v1 callback volume by ~10x; misconfigured-gateway floods
  get throttled before they degrade the rest of the API). Set to 0
  to disable; existing integration tests get this for free since
  none of them sets the env explicitly and 60/min comfortably covers
  the per-file callback volume.
- Boundary log fires once per window so ops sees throttle entry
  without pino flooding on every reject.
- 7 unit tests using jest fake timers: limit=0 disables, allows up
  to limit, throws 429 on (limit+1)th, keeps rejecting in same
  window, rolls window after 60s, doesn't roll early at 59s, logs
  exactly once at the boundary.

## Sprint 5 — Real-mode adapters + production-hardening (May 2026)

Ten slices so far (AJ–AS), backfill chore landing alongside. Theme:
every stub adapter the platform stood up over Sprints 2–4 grows a
production sibling, and the security surface gets the missing
authentication, encryption, and signature checks that the Sprint 4
exit doc flagged. End-to-end real-mode upload + virus scan + SMS
notification + JWE-signed inbound now closes the loop.

### AJ — Appeal favourable resolution auto-chains to settlement (PR #41)

- AH/AI deliberately stopped at `APPEAL_RESOLVED` so operators could
  decide what comes next. AJ closes the obvious loop: when the
  resolution kind is `approved` / `partially_approved`,
  `AppealService.resolve` delegates to `SettlementService.expectPayment`
  inside the same flow.
- Service-boundary preservation: AppealService doesn't write payment
  events directly — it calls the existing `expectPayment` so the
  state-machine + settlement-row writes go through one canonical path.
- Rejected resolutions stay manual (operator chooses write-off vs.
  another appeal cycle). Settlement creation is gated on
  `claim.approvedAmount > 0` because the state machine rejects
  `payment.expected` from `APPEAL_RESOLVED` without an approved amount.
- 3 new integration tests: approved auto-chains, partially_approved
  auto-chains, rejected stays at APPEAL_RESOLVED.

### AK — `@ApiTags` on every controller + tag descriptions (PR #42)

- AB shipped Swagger UI with auto-tagged routes (controller class
  names). AK adds explicit `@ApiTags` on all 17 controllers and the
  19 named tag descriptions on the document, so the UI groups by
  domain (`auth`, `cases`, `preauth`, `settlement`, `appeal`, …)
  rather than `AuthController`, `CaseController`, etc.
- Tag-description list lives at the document level in `openapi.ts`;
  order there drives UI presentation order.
- `operationIdFactory` returns `${controllerKey}_${methodKey}` so
  client-codegen tools get readable function names.
- Smoke test (`openapi.spec.ts`) extended to assert that the tag
  descriptions ship on the document and that a representative
  per-controller tag survives the auto-discovery pass.

### AL — Payer remittance batch reconciliation API (PR #43)

- New `POST /settlement/remittance` accepts up to 1000 rows (each:
  `claimRefNum`, `receivedAmount`, optional `receivedAt` / `bankTxnId`
  / `shortPaymentReasons`). Pre-fetches `Claim` rows by
  `claimRefNum` in a single tenant-scoped query, then dispatches each
  row to `SettlementService.recordReceipt` so the existing state-
  machine + ledger semantics stay identical to the per-claim flow.
- Per-row outcome enum: `applied | unmatched_no_claim |
  unmatched_no_settlement | failed`. The endpoint returns the full
  per-row breakdown so the operator UI can show a summary without a
  follow-up request per row.
- Failures don't roll back the batch — applied rows stay applied.
  Strict match on `claimRefNum`; fuzzy / partial matching is a
  hardening item for later if it actually becomes a problem.
- `settlement.upload_eob` permission gate; reader without it → 403.
- 3 integration tests: mixed batch (applied / short-paid / unmatched
  no claim / unmatched no settlement), RBAC, empty batch → 422.

### AM — Remittance batch upload page in the operator UI (PR #44)

- `apps/web/app/(dashboard)/admin/remittance/page.tsx` — paste-CSV →
  preview → apply batch → render results with colour-coded outcome
  badges (`applied`, `unmatched_no_claim`, `unmatched_no_settlement`,
  `failed`).
- Strict CSV parser: split on `\r?\n`, comma-split per row, semicolon-
  split for `shortPaymentReasons`. Required columns: `claimRefNum`,
  `receivedAmount`. Optional: `receivedAt`, `bankTxnId`,
  `shortPaymentReasons`. Operators pre-clean payer exports if their
  format is ugly — a real CSV parser is a Sprint 5+ hardening item if
  it becomes a problem.
- Errors surface through `useErrorModal`; per-row preview lets
  operators sanity-check before applying.
- The UI collects `bankTxnId` per row even though the API drops it
  on the floor at this slice — closed in AN.

### AN — Persist `bankTxnId` on `Settlement` (PR #45)

- Closes the gap from AM. Migration adds nullable `bankTxnId TEXT`
  on the `settlement` table; schema + `SettlementSchema` contract +
  `RecordReceiptRequest` schema all carry the field through.
- `SettlementService.recordReceipt` writes the column when set and
  the `toSettlement` mapper exposes it. Remittance dispatcher
  forwards `row.bankTxnId` instead of the prior log-only behaviour.
- Integration test now reads the raw `Settlement` row through a
  `platform_admin` tx and asserts `bankTxnId === 'BANK-9001'` for a
  row that carried one, and `null` for a row that didn't. Finance
  can now reconcile a settlement back to the originating bank line.

### AO — HCX inbound HTTP signature guard (PR #46)

- The public `/nhcx/inbound` route accepted any TLS-terminated POST
  and relied entirely on JWE for cryptographic proof. AO adds a
  Cavage HTTP-Signature guard at the HTTP edge so unsigned, replayed,
  or impersonated callbacks are rejected with 401 before the body is
  decrypted.
- Pure verifier with explicit support for `rsa-sha256` only, body
  digest binding via the `Digest` header (SHA-256), required-header
  set enforcement (so an attacker can't strip `digest` from the
  signed list), and configurable clock-skew window (default 300s,
  matches the existing JWE TTL).
- `NestExpressApplication` boots with `rawBody: true` so digest
  verification is byte-exact. Boot-time gate: `NODE_ENV=production`
  must set `NHCX_INBOUND_VERIFY_SIGNATURE=true` and
  `NHCX_GATEWAY_PUBLIC_KEY_BASE64`. Dev/test default is permissive
  per the env-gate strictness rule.
- 9 unit tests on the verifier (happy + 7 adversarial mutations) +
  4 integration tests booting the full app with verification
  enabled.
- Bugs caught in CI: supertest sends `Host: 127.0.0.1:<port>`
  regardless of `.set('Host', ...)`, so the signed signing-string
  has to use the actually-bound port (fix: pre-bind + capture the
  AddressInfo). Then `.send(Buffer)` with `Content-Type:
  application/json` makes supertest run the buffer through
  `JSON.stringify`, producing `{"type":"Buffer","data":[...]}` on
  the wire — the digest was on the original buffer, so verification
  failed (fix: send the JS object directly, compute digest on
  canonical `JSON.stringify` bytes).

### AP — KMS-wrap of tenant comms-config secrets at rest (PR #47)

- Closes CLAUDE.md hard-rule #9 for tenant `smtp.password` and
  `sms.apiKey`. Both were going into the `tenant.commsConfig` JSON
  column as plaintext; AP wraps them with AES-256-GCM under a per-
  tenant DEK derived from `PII_KMS_ROOT_KEY_BASE64` via HKDF-SHA256
  (salt `digisparsh-comms-v1`, distinct from the PII path's
  `digisparsh-pii-v1` so a key compromise on one path doesn't bleed
  across).
- On-disk format: `kms:v1:<base64(iv || ct || tag)>`. The prefix
  lets readers distinguish wrapped from legacy plaintext, so
  tenants seeded before AP keep working without a backfill.
- `TenantCommsConfigService.update` wraps before persist;
  `getConfig` unwraps on cache fill so adapters still see plaintext.
- 8 unit tests on the helper (round-trip, IV uniqueness, wrong-
  tenant-key fail-closed, wrong-root fail-closed, salt-namespacing
  isolation, legacy passthrough, key-length validation) + new on-
  disk wrap assertion in `tenant-comms-config.e2e-spec.ts` (reads
  the raw row through a `platform_admin` tx and proves the secrets
  carry the `kms:v1:` prefix and never the input strings).

### AQ — Real ClamAV INSTREAM TCP scan adapter (PR #48)

- Replaces the placeholder fall-through where `VIRUS_SCAN_MODE=real`
  silently routed to the disabled adapter (uploads passed as
  `skipped`). The new adapter speaks clamd's INSTREAM protocol over
  TCP — `zINSTREAM\0` command, 4-byte big-endian length-prefixed
  body chunks (64 KiB), zero-length end-of-stream sentinel — and
  maps clamd's three reply shapes (`stream: OK`,
  `stream: <sig> FOUND`, `... ERROR`) to the existing `ScanResult`
  enum.
- Boot-time gate: `VIRUS_SCAN_MODE=real` requires
  `VIRUS_SCAN_ENDPOINT` (host:port of clamd). Calls without an
  in-memory buffer return `failed` (loud, not silent — S3 streaming
  closed in AS).
- 12 unit tests against a `node:net` mock-clamd server: clean,
  EICAR-shaped infected, hyphenated/dotted signatures, ERROR
  replies, empty replies, multi-chunk payloads (>64 KiB), abrupt
  socket close, missing buffer, missing endpoint, connection refused.

### AR — Real TextGuru SMS provider (PR #49)

- Replaces the log-only stub for tenants whose `commsConfig.sms.provider`
  is `textguru`. POSTs to `<TEXTGURU_BASE_URL>/api/v1/sms/send` with
  bearer auth (the per-tenant `apiKey`, KMS-wrapped at rest since
  AP), JSON body `{ to, message, senderId? }`, 15s default timeout.
  Non-2xx, network errors, and timeouts throw — the upstream
  `notification_outbox` row flips to `failed` and the surrounding
  API request still succeeds (CLAUDE.md: "notification failure must
  not block").
- `SmsAdapter` now delegates to a dedicated `TextGuruSmsProvider`;
  the missing-apiKey case throws (it previously logged a warning
  and silently succeeded, which would silently drop production SMS).
- 9 unit tests against a `node:http` mock server: request shape
  (path, bearer, content-type, body keys), 401/503 throws, timeout,
  missing apiKey, missing base URL, trailing-slash stripping,
  connection refused. Mock uses `closeAllConnections()` so the
  timeout test doesn't leak the worker process between suites.

### AS — ClamAV scans presigned-PUT uploads via S3 streaming (PR #50)

- Closes the production gap from AQ. The ClamAV adapter previously
  returned `failed` for every scan input that lacked an in-memory
  `buffer` — i.e. every upload through the presigned-PUT path
  (which is most of them in `STORAGE_MODE=real`). AS extends
  `StorageAdapter` with `getObject(input) → Promise<Buffer>` and
  threads it through.
- S3 implementation: `GetObjectCommand` + `transformToByteArray`.
  Buffer is bounded by `S3_MAX_UPLOAD_BYTES` (default 50 MiB) so
  it fits in a worker's heap. Stub implementation throws on
  purpose: `VIRUS_SCAN_MODE=real` with `STORAGE_MODE=stub` is a
  misconfig and silent passthroughs are worse than a loud error.
- `ClamAvScanAdapter` now `@Inject`s `STORAGE_ADAPTER` and falls
  through to `getObject` when no buffer is provided. AccessDenied /
  NoSuchKey / etc. surface as `ScanResult { status: 'failed' }` so
  the worker retries and operators see the reason.
- 4 new clamav adapter tests (bucket/key clean, bucket/key EICAR-
  shaped infected, storage throws, neither input present) + 1 stub-
  storage test asserting `getObject` throws with a `STORAGE_MODE=
  real` hint. Buffer-path tests stay; they use a never-call storage
  stub as a regression guard against accidental S3 fetches.

## Sprint 4 — NHCX bidirectional + appeal lifecycle (May 2026)

Ten slices (Z–AI). Theme: close the NHCX integration loop. Sprint 2/3
shipped outbound only; Sprint 4 wires inbound webhooks, threads FHIR
enrichment through every phase, flips all four NHCX outbound flows
to callback-driven in real mode, and adds the appeal lifecycle that
the state machine has been waiting on since Sprint 2.

### Z — NHCX inbound webhook + FHIR response dispatcher (PR #30)

- New public endpoint `POST /nhcx/inbound`. Persists raw payload to
  `integration_message` synchronously, returns 200 within ms, then
  fires async decrypt + dispatch via `.catch`'d fire-and-forget so
  failures land on the row.
- `NhcxInboundService.receive` does idempotency check + outbound
  match + persist (all under `platform_admin` GUC because integration_
  message has FORCE ROW LEVEL SECURITY). `process` decrypts via the
  Slice U key resolver, parses with new FHIR helpers, dispatches to
  existing service `applyDecision` paths.
- Four FHIR response parsers (`CoverageEligibilityResponse`,
  `ClaimResponse` for preauth + final, `Communication`) — pure
  functions, 15 unit tests, tolerant of HCX 0.7.1 shape variations.
- 6 integration tests against an in-process JWE: eligibility +
  preauth dispatch, idempotency, unknown correlationId, missing
  header → 422, malformed JWE → row-failed-crypto.
- Bugs caught in CI: RLS-blocked polling (claims_migrator goes
  through RLS), idempotency collision with Slice K's synthetic
  inbound (differentiated on operation), RLS-blocked service reads
  (wrapped all integration_message reads in platform_admin tx),
  failure classification missing state-machine class
  (`err.constructor.name`, not `err.name`).

### AA — FHIR R4 enrichment for non-eligibility phases (PR #31)

- Slice T wired the FHIR builders into the JWE adapter for eligibility
  only. AA threads `patient + coverage + clinical fields + document
  ids` from preauth / discharge / claim-submit / communication-respond
  orchestrators so all four phases produce real FHIR Bundles.
- New `Claim.payerCode` column + migration. Captured at
  `eligibility.requested`; drives the coverage actor for every
  subsequent phase without re-passing it.
- `FhirContextService.build(tenantId, claimId)` — shared helper that
  walks case → patient → decrypted PII → AdapterPatientFields +
  AdapterCoverageFields. Replaces ad-hoc per-service inlining.
- `NhcxStubAdapter` echoes the full enriched input as `rawRequest`
  on `submitPreauth` + `submitClaim` so integration tests verify
  orchestrator → adapter wiring without a live gateway.
- 6 integration tests: payerCode stamp, preauth/discharge/claim/
  communication enrichment, legacy case (no payer at eligibility)
  keeps coverage undefined → adapter falls back to lightweight
  payload.

### AB — OpenAPI spec + Swagger UI mount (PR #32)

- Originally planned as Slice Y, deferred when Y became the FHIR
  snapshot lock. `@nestjs/swagger@7.4` (Nest-10-compatible major;
  v11+ expects a newer `@nestjs/core` path that doesn't exist in
  pinned 10.3.9 — caught at test time).
- `src/openapi.ts` mounts `/api/docs` (Swagger UI) + `/api/docs-json`
  (raw OpenAPI 3 spec). Cookie-auth security scheme declared globally;
  the UI's "Authorize" button drops the JWT into the right cookie.
- `SWAGGER_ENABLED` env knob (default `true`); production deployments
  flip to `false` for a 404 on both routes.
- 2 unit tests: spec is structurally valid + cookie-auth scheme
  present + routes auto-discovered + disable flag works.
- Auto-tagged from controller class names; per-controller `@ApiTags`
  polish is a follow-up cleanup slice (17 controllers).

### AC — Eligibility callback-driven in real mode (PR #33)

- Removes the duplicate-transition bandaid Slice Z's eligibility test
  had to assert: `expect(['succeeded', 'failed']).toContain(...)`.
  In real mode, the orchestrator now stops at
  `ELIGIBILITY_CHECK_PENDING` and the gateway's webhook callback runs
  the verified/failed transition cleanly.
- `EligibilityService.run` gated on `NHCX_MODE`. Real mode skips the
  synthetic inbound row + the auto-transition. Outbound row stays
  `pending` until the inbound dispatcher pairs the callback.
- New `eligibility-callback-driven.e2e-spec` exercises the real-mode
  path against an in-process mock NHCX gateway (Slice P pattern).

### AD — Preauth callback-driven in real mode (PR #34)

- Same shape as AC but with preauth's two-step state-machine path
  (`DRAFTING → QUEUED → SUBMITTED → APPROVED|REJECTED|...`).
  Orchestrator stops at QUEUED in real mode.
- New `PreauthService.handleInboundResponse` runs the two-step
  transition: ack `QUEUED → SUBMITTED` (with `payerRefNum` stamped
  if available) then delegates to `applyDecision`. Idempotent: ack
  is skipped when claim is already at SUBMITTED (admin escape-hatch
  path).
- `NhcxInboundService.preauth/on_submit` routes through the new
  handler. `applyDecision` stays as the admin escape hatch.
- New `preauth-callback-driven.e2e-spec` against the mock gateway.

### AE — Claim-submit callback-driven in real mode (PR #35)

- Symmetric with AD but with `claim.*` events. Orchestrator stops at
  `CLAIM_QUEUED`; `ClaimSubmitService.handleInboundResponse` runs
  ack + decision.
- `claimRefNum` is stamped synchronously on the claim row at the
  QUEUED step (the JWE adapter's response envelope has it; Sprint 5
  follow-up extends `parseClaimResponse` to extract identifier so
  the stamp moves to the callback).
- New `claim-submit-callback-driven.e2e-spec` walks the full
  pipeline (eligibility + preauth callbacks → discharge synchronous
  → claim submit + callback → CLAIM_APPROVED).

### AF — Discharge callback-driven in real mode (PR #36)

- Last NHCX phase to flip. Discharge has the simplest state-machine
  path (no payer decision — single `DISCHARGE_PENDING →
  DISCHARGE_SUBMITTED` transition) but uses `communication/request`
  for the inbound, so the dispatcher disambiguates three shapes via
  a new `lookupOutboundOperation` helper:
    1. matching outbound = `discharge.submit` → discharge ack (this
       slice)
    2. matching outbound = `preauth.query.respond` → query response
       ack (log-only; the state transition already happened
       synchronously when sent)
    3. no matching outbound → payer-initiated query (Slice Z
       behaviour)
- Sprint 4 milestone: with AF, all four NHCX outbound flows are
  callback-driven in real mode.
- New `discharge-callback-driven.e2e-spec` + cleanup of AE's test
  (which relied on discharge auto-transitioning).

### AG — Sender-code allowlist on /nhcx/inbound (PR #37)

- Defense-in-depth on top of Slice Z's JWE-intrinsic auth. The
  webhook is public; the JWE provides cryptographic guarantees
  *after* decryption succeeds, but doesn't prove the sender claims
  to be a known payer until we open the ciphertext.
- `NhcxSenderAllowlistService` — process-local cache (60s TTL,
  invalidate hook for write-through). Source of truth: `Payer.hcxCode`
  for active rows. Reads under `platform_admin` tx (Payer table has
  FORCE ROW LEVEL SECURITY).
- Default-permit when empty so test rigs without seeded payers keep
  working. Production gets enforcement once the Slice O master-data
  seed loads.
- New `'rejected_sender'` outcome surfaces in logs without writing
  an integration_message row. Controller still returns 200 (NHA
  must not retry on a configuration mismatch).
- 6 unit + 5 integration tests.

### AH — Appeal lifecycle (PR #38)

- The appeal state-machine path has been in `claim.state-machine.ts`
  since Sprint 2 with no service or controller. Operators have been
  doing appeals out-of-band; AH gives them the in-product flow.
- `Appeal` Prisma model + migration `20260521_appeal` with the
  standard tenant-scoped RLS policies. One row per appeal cycle,
  status (`initiated|submitted|resolved`), resolution kind + amount,
  supporting documents.
- `AppealService.start / submit / resolve` driving `appeal.started →
  appeal.submitted → appeal.resolved`. Approved + partially_approved
  stamp `approvedAmount` on the claim row.
- 4 endpoints under `/cases/:c/claims/:cl/appeal/{start,submit,
  resolve}` + `GET` for the open appeal. `settlement.appeal`
  permission gate on writes; `case.view` on the GET.
- Settlement boundary kept clean: AppealService only drives
  `appeal.*` events. Auto-chain to settlement is a Sprint 5 backlog
  item.
- 8 integration tests covering happy + rejection + RBAC + double-
  submit + approved-without-amount validation.

### AI — Appeal panel on case detail (PR #39)

- Wires the AH appeal API to the case detail page. Panel visibility
  gated on three lifecycle bands:
    - **eligible** (PREAUTH_REJECTED / CLAIM_REJECTED / SHORT_PAID)
      → "Ground for appeal" textarea + Start button
    - **live** (APPEAL_INITIATED / APPEAL_SUBMITTED / APPEAL_RESOLVED)
      → action for the current step
    - **historical** (PAYMENT_* / WRITTEN_OFF / CLOSED with an
      existing appeal row) → read-only summary
- `CaseApi` gains `getAppeal / startAppeal / submitAppeal /
  resolveAppeal`.
- Resolve form switches between approved / partially_approved /
  rejected, hides the approvedAmount input on rejected (matches API
  validation).
- Post-resolve hint points operators at the SettlementPanel for the
  next step (write-off / expect payment) — preserves AH's explicit
  no-auto-chain boundary.

## Sprint 3 — Production hardening (May 2026)

Eight slices (R–Y) on top of the Sprint 2 business-domain skeleton.
Theme: every Sprint 2 stub picks up a production sibling, and the
multi-tenant surface gets the encryption / scanning / per-tenant
config that compliance asks for. CI gate now also runs MinIO + the
FHIR snapshot tests.

### R — Encrypted patient PII (PR #21)

- `Patient` model with envelope-encrypted Aadhaar / ABHA / policy /
  mobile / email — AES-256-GCM with per-tenant DEK derived via
  HKDF-SHA256 from `PII_KMS_ROOT_KEY_BASE64`. Ciphertext blob is
  `base64(iv || ct || tag)` with `keyVersion` stored alongside so
  rotation doesn't require atomic re-encrypt.
- Exact-match lookup hashes (`aadhaarHash`, `mobileHash`) co-located
  with the ciphertext so we find a patient without a full-table
  decrypt scan.
- `CaseService.create` atomically creates the `Patient` row inside the
  same tenant tx when `CreateCaseRequest.patient` is supplied. Legacy
  cases (no PII) keep `patientId = null`.
- Real OVH KMS deferred to Sprint 5; config loader rejects
  `PII_KMS_MODE=real`. Production-only enforcement of
  `PII_KMS_ROOT_KEY_BASE64` so non-prod test harnesses don't have to
  mint a 32-byte key.
- 12 unit + 4 integration tests.

### S — Document virus-scan + lifecycle sweep (PR #22)

- `VirusScanAdapter` interface + three impls gated by
  `VIRUS_SCAN_MODE` — `off` / `stub` (EICAR detect) / `real`
  (ClamAV INSTREAM, deferred to Sprint 5).
- `finalizeUpload` runs the scanner; infected rows flip
  `scanStatus='infected'` + return 422. `hasDocumentType()` now
  requires `scanStatus IN ('clean','skipped')` so infected uploads
  never satisfy the discharge / claim-submit checklist.
- `DocumentLifecycleWorker` sweeps `pending` rows older than
  `DOC_PENDING_TTL_MINUTES` (default 60) to `failed`, so stale uploads
  stop showing up as "still uploading".
- 5 unit + 3 integration tests.

### T — Real FHIR R4 bundle builders (PR #23)

- Four pure-function builders for the HCX 0.7.1 profile:
  `CoverageEligibilityRequest` (eligibility), `Claim use=preauthorization`
  (preauth submit), `Claim use=claim` (final submit with `Binary` refs),
  `Communication` (query response + discharge submit).
- `NhcxJweAdapter` materialises bundles when patient/coverage/clinical
  fields are supplied; falls back to the legacy lightweight payload
  otherwise so the stub and existing call sites keep working.
- Eligibility service forwards plaintext patient fields + decrypts the
  linked `Patient` row to populate `dateOfBirth` / `gender` / `abhaId`.
  Aadhaar / mobile / email never leave the database.
- Sprint 5 follow-up: forward enriched fields from preauth /
  discharge / claim-submit too. Eligibility was wired first as the
  highest-traffic NHCX call.
- 11 unit + 1 integration test.

### U — ABDM token cache + NHCX key rotation (PR #24)

- `TokenCache` — process-local TTL cache for ABDM OAuth2 tokens with
  concurrent-miss collapse (no thundering herd at expiry).
  `HprRealAdapter` reads via the cache + `httpJsonWith401Retry`
  invalidates and remints on a 401 then retries the original call once.
- `EnvKeyResolver` (NHCX) maps version strings to PEM blobs. Active
  version (`NHCX_PRIVATE_KEY_VERSION`, default `v1`) drives outbound
  encryption (`kid` stamped on the JWE header). Inbound JWEs decrypt
  using the version named in their `kid`, so v1 ciphertext from NHCX
  still opens after we cut over to v2 outbound. Adding v3 = a new env
  slot + a one-line resolver entry.
- `nhcx.crypto.readJweKid` exposes `decodeProtectedHeader` so the
  adapter reads `kid` without partial-decrypting the payload.
- 12 unit + 2 integration tests.

### V — Audit viewer + streaming CSV export (PR #25)

- `GET /audit` — paginated list with filters (from / to, action,
  resourceType, resourceId, actorUserId, correlationId), gated by
  `audit.view`.
- `GET /audit/export.csv` — same filters, streamed via the underlying
  Express response. `AuditService.streamForExport` is an async
  generator yielding 500-row batches; controller pipes straight to
  `res.write`. 100k-row hard cap so memory stays bounded.
- `apps/web/.../admin/audit/page.tsx` — filter inputs, paginated
  table, "Download CSV" anchor that opens the export URL with cookies
  attached so the browser handles streaming + the download flow.
- 6 integration tests including a cross-tenant isolation canary.

### W — Real-MinIO S3 round-trip + finalize-failure tests (PR #26)

- `test/setup/minio-container.ts` spins up MinIO via testcontainers
  and creates the test bucket. Drop-in S3 API surface so SigV4
  presigned PUT + HEAD work unchanged against it.
- `document-real-s3.e2e-spec.ts` — happy path (upload-init → PUT
  bytes via the presigned URL with `fetch` mirroring the browser →
  finalize captures the real etag and observed content-length) and
  failure path (skip the PUT → finalize HEAD returns 404 → row flips
  to `failed` with `uploadError`, surface 422).
- Closes the two gaps called out in the Slice P2 PR.
- `cross-env NODE_OPTIONS=--experimental-vm-modules` on the
  integration runner so the AWS SDK v3's dynamic imports
  (middleware-retry) resolve under Jest. `cross-env` added as a devDep
  for portable shell behaviour.
- Post-CreateBucket `HeadBucket` poll (5x / 200ms) handles MinIO's
  occasional bucket-visibility lag after create.

### X — Per-tenant SMTP + SMS config (PR #27)

- `Tenant.commsConfig` JSONB stores per-tenant overrides for the
  SMTP relay and SMS provider; falls back to platform env defaults
  when unset.
- `TenantCommsConfigService` resolves + caches per-tenant config (60s
  TTL, invalidate on write). `EmailAdapter` and `SmsAdapter` thread
  `tenantId` through every send so per-tenant Transporters and SMS
  providers select cleanly. `TextGuru` provider is a logging stub
  today; real HTTP integration in Sprint 5.
- `PATCH /tenant/comms-config` edits, `GET` returns a redacted summary
  (`passwordSet` / `apiKeySet` flags — never raw secrets). New
  permission `tenant.comms_config.update` gates both verbs; seeded
  into `tenant_admin` and `platform_admin`.
- `apps/web/.../admin/comms-config/page.tsx` — operator form that
  preserves existing secrets when the password / api-key fields are
  left blank.
- Bug fix: `SMTP_PORT` coerced to number at the resolver boundary
  because `ConfigService` can surface raw env strings.
- 6 unit + 5 integration tests.

### Y — FHIR builder snapshot lock (PR #28)

- Optional `uuid` + `now` factory injection on the four NHCX FHIR R4
  builder inputs (`FhirDeterminismDeps`). Production callers omit
  them; defaults remain `crypto.randomUUID` and the system clock.
- `apps/api/src/modules/nhcx/fhir-builders.snapshot.spec.ts` — 4 tests
  building each bundle with deterministic factories and asserting
  deep equality against pretty-printed reference fixtures in
  `reference/fhir-bundles/`. Set `UPDATE_FIXTURES=1` to regenerate
  intentionally; the diff lands in the PR for review.
- `reference/fhir-bundles/{eligibility-request,preauth-submit,claim-submit,communication}.json`
  — committed canonical bundles (the directory CLAUDE.md already
  pointed at for contract tests).

## Sprint 2 — Business domain + real adapters (May 2026)

Nine slices (I–Q) building the case → preauth → discharge → claim →
settlement pipeline on top of the Sprint 1 auth surface, plus the
first real-network NHCX / ABDM / S3 adapters and the production-deploy
hardening. CI gate adds the integration_message ledger canaries.

### I — Event-sourced claim aggregate engine (PR #10)

- Three new tables: `case` (minimal — patient details are placeholder
  strings until the encrypted Patient model lands in Slice R),
  `claim` (materialised state), `claim_event` (append-only via RLS).
- Full 35-status `ClaimStatus` enum + 38 `ClaimEventType` verbs lifted
  verbatim from `docs/04-state-machines.md`. Explicit transition table
  (~55 rows) with O(1) lookups; module-load asserts uniqueness so a
  duplicate transition fails fast.
- `ClaimService.create` / `transition` / `findById` / `listEvents`.
  Every transition opens a tenant-context tx, validates `(from, event)`,
  writes a `ClaimEvent`, updates the materialised `claim.status`
  atomically, and auto-stamps `submittedAt` / `approvedAt` / `paidAt`
  / `closedAt` based on the resulting status.
- `ClaimReconstructionService.replay` — pure function over the event
  log. Reports `{status, eventCount, history, consistent}`.
- `claim_event` has `USING(false)` on UPDATE/DELETE so application
  code that tries to mutate a recorded event is silently rejected.
- 11 unit + 6 integration tests.

### J — Case + claim CRUD over HTTP (PR #11)

- `POST /cases` creates the `Case` row AND mints the first `Claim`
  via `ClaimService.create` (two writes, separate txs) so callers
  get a fully-shaped aggregate from one round-trip. Atomic wrapping
  deferred until the encrypted Patient model lands.
- `CaseController` — `POST` / `GET` / `GET /:id` / `PATCH`, gated by
  `case.create` / `case.view` / `case.assign`.
- `ClaimController` — `GET /cases/:cid/claims/:clid/events` (timeline)
  + `POST .../transitions` (admin manual transition gated by
  `case.assign` — production transitions come from rail adapters).
- Wire shapes: `CaseSummary` (list page) + `CaseDetail` (detail page,
  embeds claims) + `ClaimEventListItem` (timeline). Server-side
  pagination clamped to `[1, 200]`.
- Web: `/cases` list with status filter, `/cases/new` create form,
  `/cases/[id]` detail panel with claims + timeline.
- 8 integration tests including cross-tenant invisibility canary.

### K — NHCX-stub eligibility cycle + integration_message ledger (PR #12)

- `IntegrationMessage` model — every external call (NHCX, PMJAY,
  ABDM, OpenAI, SMTP, TextGuru) writes a paired outbound + inbound
  row sharing one `correlationId`. `status` flips
  `pending → succeeded | failed`; `failureClass` classifies
  network / auth / validation / 5xx.
- `IntegrationMessageService.recordOutboundWithTx` (atomic with the
  surrounding state change), `markSucceeded` (updates outbound +
  writes inbound), `markFailed`, `listForClaim`.
- `NhcxStubAdapter` — env-driven verify result with per-MRN fail-list
  override. Mirrors the eventual real-adapter shape so swap is
  contained to one file in Slice P. 5ms mock latency.
- `EligibilityService` orchestrator — opens a tenant tx, transitions
  `eligibility.requested`, calls the adapter outside the tx (no
  network round-trip while holding locks), writes paired ledger rows
  under one correlationId, transitions to `ELIGIBILITY_VERIFIED` or
  `ELIGIBILITY_FAILED`.
- `POST /cases/:c/claims/:cl/eligibility` (`case.create`) +
  `GET .../integration-messages` (`case.view`).
- Web: case detail gains an Eligibility action panel + ledger view.
- 6 integration tests.

### L — Pre-auth phase end to end (PR #13)

- `preauth_draft` (one row per claim, unique on `claimId`, upsert);
  per-field state captured in `submittedSnapshot` at submit so a
  later edit can't silently change what we believe we sent.
- `preauth_query` — payer-raised queries; `respondedAt` /
  `responseText` flip on response.
- `NhcxStubAdapter` gains `submitPreauth` / `respondPreauthQuery`.
  `EligibilityModule` now exports the adapter so `PreauthModule`
  shares it (one fewer instance).
- `PreauthService` — `saveDraft` (upsert), `submit` (required-field
  check, `DRAFTING → QUEUED`, adapter call, paired ledger rows,
  `QUEUED → SUBMITTED` with `payerRefNum` stamped on the claim),
  `applyDecision` (admin escape hatch + path Slice P's adapter
  callback wires through), `respondToQuery`.
- Endpoints under `/cases/:c/claims/:cl/preauth` gated separately by
  `preauth.draft` / `preauth.submit` / `preauth.respond_query` /
  `case.assign`.
- Web: `PreauthPanel` on case detail. Form binds to the draft;
  Save / Submit are split. Form goes read-only once the claim leaves
  `DRAFTING` / `QUEUED`.
- 7 integration tests.

### M — Discharge + claim submit phase end to end (PR #14)

- `Document` model — file metadata only; binaries land in S3 in
  Slice P2. Tenant-scoped, indexed on `(claimId, documentType)` so
  the required-doc check is a cheap count.
- `DocumentService.uploadStub` creates a synthetic
  `storageBucket` / `storageKey` so downstream flows have a row to
  link.
- `NhcxStubAdapter` gains `submitDischarge` / `submitClaim` —
  acknowledged-only, decisions still arrive via the admin endpoint.
- `DischargeService.initiate` / `submit` — submit guards on at-least-
  one document of type `discharge_summary`; missing → 422.
- `ClaimSubmitService.start` / `submit` / `applyDecision`. `submit`
  takes `finalAmount` on the wire (the requested pre-auth amount
  was an estimate; `finalAmount` is what we're actually billing).
- Endpoints under `/cases/:c/claims/:cl/{documents, discharge,
  claim-submission}` with permission gates per verb.
- Web: `ClaimPhasePanel` on case detail with inline document upload
  stub + discharge / claim submit buttons gated on status.
- 7 integration tests.

### N — Settlement: payment, EOB, reconciliation, write-off (PR #15)

- `Settlement` model — one row per claim, unique on `claimId`. Tracks
  `expectedAmount`, `receivedAmount`, `deductionAmount`, structured
  `deductions` JSONB, `shortPaymentReasons`, `eobDocumentId` (FK-by-id
  to `Document`), `reconciliationStatus`
  (`manual_match_pending → auto_matched | short_paid | discrepancy`),
  `closedAt`.
- `SettlementService` — `expectPayment` (idempotent upsert + drives
  `payment.expected`), `recordReceipt` (auto-classifies `short_paid`
  when `received < expected`, drives `payment.received` →
  `payment.short_paid`, stamps `paidAmount` on the claim),
  `reconcile`, `writeOff` (drives `claim.written_off` — terminal-
  bound), `close` (drives `claim.closed` + stamps `closedAt`).
- Endpoints under `/cases/:c/claims/:cl/settlement` gated by
  `case.assign` / `settlement.upload_eob` /
  `settlement.categorize_deduct` / `settlement.write_off`.
- Web: `SettlementPanel` on the case detail page, status-conditional
  CTAs (receipt, reconcile, write-off, close) from `CLAIM_APPROVED`
  through `CLOSED`.
- State-machine fix mid-slice: `payment.short_paid` only follows
  `payment.received`, never directly from `PAYMENT_PENDING`. Same
  materialised state, valid event sequence.
- 7 integration tests.

### O — Master data: payer, package, ICD, billing, checklist (PR #16)

- Platform-level catalogues (no `tenantId`) — `Payer` (TPA / insurer /
  SHA / CGHS / self with NHCX participant code), `Package` (PMJAY HBP
  + private-rail tariff), `IcdCode` (ICD-10-CM with description
  search), `BillingCode`, `DocumentChecklistRule`.
- `resolveChecklist` picks the most-specific rule per `documentType`
  with a (phase, rail) → optional payer / package / admissionType
  precedence.
- RLS — SELECT open to any authenticated context, INSERT/UPDATE/DELETE
  `platform_admin` only. Endpoints under `/payers`, `/packages`,
  `/icd-codes`, `/billing-codes`, `/document-checklist-rules` gated by
  `payer.master.{view,edit}` / `package.master.sync` /
  `document_checklist.edit`.
- Seed: `pnpm db:seed:master` loads 10 payers, 14 packages, 21 ICD
  codes, 15 billing codes, 13 checklist rules — idempotent.
- Side change: `ZodValidationPipe` now uses
  `ZodType<T, ZodTypeDef, unknown>` so schemas with `.transform()`
  pass the constraint.
- 7 integration tests.

### P — Real NHCX JWE adapter + mode switch (PR #17)

- `NhcxAdapter` interface lifted into its own `@Global` module with
  two impls: `NhcxStubAdapter` (existing behaviour) and
  `NhcxJweAdapter` (RSA-OAEP-256 + A256GCM JWE wrapping over native
  `fetch`, configurable gateway URL).
- `NHCX_MODE=stub|real` (default `stub`). Real mode requires
  `NHCX_GATEWAY_URL`, `NHCX_PARTICIPANT_CODE`,
  `NHCX_PRIVATE_KEY_BASE64`, `NHCX_GATEWAY_PUBLIC_KEY_BASE64` —
  config loader rejects boot when missing.
- Consumers (eligibility, preauth, discharge, claim-submit) now
  inject the `NHCX_ADAPTER` token instead of the concrete class so
  swap is transparent.
- `nhcx.crypto` — `jose` v5 (pinned for CJS interop). Imported keys
  are cached keyed on PEM string so per-request encryption isn't
  paying the SPKI parse cost.
- 3 unit + 4 integration tests against an in-process mock gateway:
  encrypt/decrypt round-trip, opaque-on-the-wire (PHI never appears
  plaintext), HTTP 503 surfaces as a thrown error, payload propagation.

### P2 — S3 presigned upload pipeline (PR #18)

- `StorageAdapter` interface + two impls: `StubStorageAdapter`
  (synthetic refs, dev + tests) and `S3StorageAdapter` (presigned
  PUTs against an S3-compatible service via AWS SDK v3 — OVH default,
  works against MinIO / AWS S3 too).
- `STORAGE_MODE=stub|real`; real mode requires
  `OVH_S3_{ENDPOINT,REGION,BUCKET,ACCESS_KEY,SECRET_KEY}`.
- `Document` table extended: `uploadStatus`
  (`pending|completed|failed`), `contentSha256`, `uploadError`,
  `finalizedAt`. Existing rows backfill to `completed`.
- Two new endpoints — `POST .../documents/upload-init` allocates a key,
  signs a PUT URL, creates the `pending` row; `POST .../finalize` HEADs
  the object, captures `etag` + size, flips the row to `completed`.
  Legacy `/upload-stub` retained for backward compat + dev.
- `hasDocumentType()` now requires `uploadStatus='completed'` so
  pending uploads don't satisfy the discharge / claim checklist.
- 2 unit + 4 integration tests.

### P3 — Real ABDM HPR adapter + two-step OTP flow (PR #19)

- `HprAdapter` interface + `HPR_ADAPTER` token. Two impls:
    - `HprStubAdapter` — moved from `doctor/hpr.service.ts`. Allowlist
      + fixed-OTP gating. Now exposes `requestOtp()` returning a
      synthetic `transactionId` so the two-step flow works in stub
      mode.
    - `HprRealAdapter` — talks to ABDM Sandbox over `fetch`:
      `/gateway/v0.5/sessions` (access token), `/api/v1/auth/init`
      (txnId), `/api/v1/auth/confirmWithMobileOTP` (x-token),
      `/api/v2/hpr/healthcareprofessional/{hprId}` (profile).
      Failures bucket up into `HprVerificationFailedError` so callers
      can't distinguish "wrong OTP" from "wrong HPR" (D-014).
- `HPR_MODE=stub|real` (default `stub`). Real mode requires
  `ABDM_BASE_URL` / `ABDM_CLIENT_ID` / `ABDM_CLIENT_SECRET`;
  `ABDM_HTTP_TIMEOUT_MS` bounds each leg.
- `DoctorTokenService` injects `HPR_ADAPTER` and exposes
  `requestHprOtp()`. `SignWithDoctorTokenInput` grows an optional
  `hprTransactionId` — required by the real adapter (links the OTP
  back to init), ignored by the stub.
- New endpoint `POST /preauth/doctor-tokens/:rawToken/hpr-init` (step
  1 of the two-step real-ABDM flow).
- 5 unit + 5 integration tests against a mock ABDM sandbox.

### Q — Security headers + retry worker + readiness probe (PR #20)

- Security-headers middleware, hand-rolled rather than helmet so the
  policy is auditable. CSP (`default-src 'none'`,
  `connect-src CORS_ORIGIN`), `X-Content-Type-Options`,
  `X-Frame-Options DENY`, `Referrer-Policy no-referrer`,
  `Permissions-Policy` denying camera/mic/etc, COOP `same-origin`,
  CORP `same-site`. HSTS gated on `COOKIE_SECURE` — production
  preload-grade, non-prod `max-age=300` to avoid locking dev. Express
  `X-Powered-By` stripped.
- `NotificationRetryWorker` — in-process timer that drains
  `notification_outbox` rows in `queued|failed` state with
  `attempts < cap`. Exponential back-off (0s / 60s / 5m / 30m / 2h).
  Permanent failures (unknown template, channel mismatch) burn all
  attempts atomically. Disable in tests via
  `NOTIFICATION_RETRY_DISABLED=true`.
- `/health/ready` reports database connectivity,
  `_prisma_migrations` freshness (every applied migration finished +
  not rolled back), bound adapter modes (nhcx / hpr / storage), and
  build provenance — load balancers can pull instances out of
  rotation when migrations are mid-flight or rolled back.
- 4 unit (security headers) + 6 unit (retry back-off schedule) +
  4 integration tests.

## Sprint 1 — Auth + onboarding (May 2026)

Authentication, RBAC, MFA, sessions, doctor signature, tenant onboarding
and lifecycle. 65 integration tests; CI gate is the RLS canary +
end-to-end auth flows.

### A — RBAC + audit pipeline (PR #2)

- `RolesGuard` + `@RequirePermission` decorator backed by the
  JWT-embedded permission set (no per-request DB hit).
- `AuditService.record` / `recordWithTx` + Slice-A audit events
  (`USER_LOGGED_IN/OUT/FAILED_LOGIN/LOCKED`).
- 3-phase login split fixes a pre-existing lockout bug — failed-attempt
  counters now persist across `throw` in the failure path.

### B — Invitation flow + notifications (PR #3)

- `POST /tenant/users` admin invite + `POST /tenant/users/:id/resend-invite`.
- `POST /auth/accept-invite` + `GET /auth/invite/:token` preview.
- `NotificationService` with persistent outbox pattern; post-commit
  dispatch so notification failure never rolls back state changes.
- Invite resend rate-limited (3/24h per user).

### C — Password policy + reset + history (PR #4)

- `PasswordPolicyService` — length, composition, contextual (no email /
  name), bundled offline breach list (sha1 hex set), reuse-of-last-5.
- `POST /auth/password-reset/{initiate,verify,complete}` + opaque
  30-min tokens, 5/day rate limit, silent on unknown email.
- `POST /auth/me/password` self-change with current-password proof.
- `password_history` (append-only via RLS).

### D — MFA — TOTP + backup codes (PR #5)

- `TotpService` (otplib) + `BackupCodeService` (10 single-use
  Crockford-base32 codes per batch).
- `POST /auth/me/mfa/{setup,confirm,disable}` +
  `POST /auth/me/mfa/backup-codes/regenerate`.
- 5-minute MFA challenges replace the access token issue when MFA is
  enabled. `POST /auth/mfa/verify` finishes login.
- Same-step TOTP replay blocked via `lastUsedStep` on the enrolment row.

### E — Sessions, IP allowlist, trusted devices, concurrent cap (PR #6)

- IP allowlist as tenant-level CIDR list (jsonb). IPv4 + IPv6.
  Hand-rolled matcher (deprecated `ip` package avoided). platform_admin
  bypasses; IPv4-mapped IPv6 (`::ffff:1.2.3.4`) normalised before match.
- `claims_trust` cookie + `TrustedDevice` model — opting into "trust
  this device for 30 days" on the MFA challenge skips MFA on follow-up
  logins from the same UA.
- Concurrent-session cap (default 5) — FIFO eviction at the cap+1th
  login with `SESSION_REVOKED` audit + history-row to keep the
  refresh-reuse detector intact.
- `GET /auth/me/sessions`, `DELETE /auth/me/sessions/:id`,
  `GET /auth/me/trusted-devices`, `DELETE /auth/me/trusted-devices/:id`,
  `GET/PUT /tenant/security/ip-allowlist`.

### F — Doctor short-token + HPR stub (PR #7)

- `DoctorTokenService` + `HprService` (env-allowlist stub mirroring the
  shape of the eventual ABDM HPR API).
- `POST /preauth/doctor-tokens` (auth, perm `preauth.sign_clinical`),
  `GET /preauth/doctor-tokens/:rawToken/preview` (public),
  `POST /preauth/doctor-tokens/:rawToken/sign` (public).
- 10-minute token TTL; single-use; `DOCTOR_SIGNED` audit captures HPR
  id + verified full name + clinical note.

### G — Onboarding + readiness + lifecycle FSM (PR #8)

- 8 canonical onboarding step keys + idempotent upsert at
  `POST /tenant/onboarding/steps/:key/complete`.
- `ReadinessService` — pure check over steps + tenant_admin presence +
  non-terminal lifecycle.
- `TenantLifecycleService` — explicit FSM
  (`CONTRACTED → PROVISIONING → IN_SETUP → PILOT → LIVE`,
  `LIVE ↔ SUSPENDED`, `PILOT/LIVE → CHURNED`). FSM check runs before
  readiness so the more actionable `LIFECYCLE_TRANSITION_INVALID`
  surfaces over `READINESS_CHECK_FAILED`.

### H — Cleanup + sprint exit

- 4 runbooks (locked-account, lost-MFA, IP-allowlist self-lockout,
  refresh-reuse detected) under `docs/runbooks/`.
- `docs/sprint-1-exit.md` summarises what shipped + Sprint 2 backlog.
- This changelog file.

## Sprint 0 — Walking skeleton (May 2026, PR #1)

- pnpm monorepo (`apps/api` NestJS 10, `apps/web` Next.js 14,
  `packages/{contracts,error-codes,ui-tokens}`).
- Postgres 16 with `claims_migrator` (owner) + `claims_app` (runtime,
  no BYPASSRLS) roles.
- Tenant-scoped RLS via `set_config('app.tenant_id', ..., true)` GUC;
  8-assertion canary integration test as the gate.
- RS256 JWT cookies + refresh-token rotation + reuse-detection.
- CI: lint + type-check, unit tests, integration tests on testcontainers
  Postgres.
