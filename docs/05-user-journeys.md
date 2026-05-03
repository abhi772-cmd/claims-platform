# 05 — User Journeys with Endpoints

This doc maps every user journey to the screens they touch and the endpoints they invoke. Use this when scoping a feature, designing a screen, or wiring up the API client.

Endpoint base path: `/api/v1`. All endpoints require auth except where noted.

---

## Journey index

1. **J-01** — Insurance desk: NHCX cashless preauth happy path
2. **J-02** — Insurance desk: NHCX preauth with query handling
3. **J-03** — Insurance desk: NHCX enhancement during stay
4. **J-04** — Insurance desk: NHCX final claim submission
5. **J-05** — Insurance desk: NHCX reimbursement claim
6. **J-06** — PMAM: PMJAY preauth (assist mode)
7. **J-07** — PMAM: PMJAY claim submission
8. **J-08** — PMAM: PMJAY query handling
9. **J-09** — Insurance desk: claim denial and appeal
10. **J-10** — Insurance desk: settlement and reconciliation
11. **J-11** — Billing manager: AR review and SLA escalation
12. **J-12** — Doctor: clinical justification and signature
13. **J-13** — CFO: analytics dashboard exploration
14. **J-14** — Admin: tenant setup, user management, payer master
15. **J-15** — Patient: OTP and consent capture
16. **J-16** — System: ABHA verification flow
17. **J-17** — System: scheduled SLA breach alerts

---

## J-01 — NHCX cashless preauth happy path

**Persona**: Insurance desk executive
**Trigger**: Patient walks into the hospital with a TPA/insurer card and is admitted for a planned procedure.

| Step | Screen                          | Action                                          | Endpoint                                              |
|------|----------------------------------|------------------------------------------------|-------------------------------------------------------|
| 1    | Cases list                       | Click "New Case"                               | `GET /cases?status=open`                              |
| 2    | New Case form                    | Enter MRN, fetch patient from HIS              | `POST /patients/lookup`                               |
| 3    | Patient confirm                  | Confirm or update patient details              | `POST /patients` (or `PATCH /patients/:id`)           |
| 4    | Policy capture                   | Enter policy number; system fetches plan       | `POST /policies/lookup` (calls NHCX insurance plan)   |
| 5    | Policy confirm                   | Verify member ID, sum insured                  | `POST /policies` (creates record)                     |
| 6    | Coverage check                   | Auto-trigger coverage eligibility              | `POST /eligibility/check`                             |
| 7    | Eligibility result               | "Eligible — ₹5,00,000 SI, ₹50,000 deductible" | (polled via `GET /cases/:id/eligibility`)             |
| 8    | Preauth form                     | Fill diagnosis (ICD), procedure (ICHI), amount | `POST /preauth/draft`                                 |
| 9    | Document upload                  | Drag-drop preauth form, investigations         | `POST /documents` (multipart, returns presigned PUT)  |
| 10   | Doctor signature request         | Send link to doctor                            | `POST /preauth/:id/request-signature`                 |
| 11   | Submit preauth                   | Click Submit                                    | `POST /preauth/:id/submit` → 202 Accepted             |
| 12   | Live status panel                | "Submitted to NHCX, awaiting response"         | SSE: `GET /cases/:id/events` (Server-Sent Events)     |
| 13   | Approval modal                   | "Pre-auth Approved — ₹3,80,000"                | (callback updates state, SSE pushes to UI)            |

**Backend events** in order: `case.created` → `eligibility.requested` → `eligibility.verified` → `preauth.drafting_started` → `preauth.submitted_internally` → `preauth.acknowledged_by_payer` → `preauth.approved`.

**Modal copy at each step**: see `reference/error-codes.md` for failure cases.

---

## J-02 — NHCX preauth with query

Same as J-01 through step 12. Then:

| Step | Screen                  | Action                                         | Endpoint                                              |
|------|--------------------------|------------------------------------------------|-------------------------------------------------------|
| 13   | Query notification       | Toast + sidebar badge: "Query received"        | (SSE notification)                                    |
| 14   | Case detail              | Read query text, see what's being asked        | `GET /preauth/:id/queries`                            |
| 15   | Doctor consult           | Optional: tag doctor, request clarification    | `POST /cases/:id/notes`                               |
| 16   | Query response form      | Type response, attach additional docs          | `POST /preauth/:id/queries/:queryId/respond`          |
| 17   | Awaiting reply panel     | Status: PREAUTH_QUERY_RESPONDED                | (SSE)                                                  |
| 18   | Approval / next query    | Either resolved or another query               | (SSE)                                                  |

---

## J-03 — NHCX enhancement during stay

**Trigger**: Patient's condition worsens; ICU stay extended; bill estimate exceeds approved preauth.

| Step | Screen                  | Action                                         | Endpoint                                              |
|------|--------------------------|------------------------------------------------|-------------------------------------------------------|
| 1    | Case detail              | Click "Request Enhancement"                    | `POST /enhancement/draft`                             |
| 2    | Enhancement form         | New estimate, justification                    | `PATCH /enhancement/:id`                              |
| 3    | Documents                | Add updated investigations                     | `POST /documents`                                     |
| 4    | Submit                   | Submit                                          | `POST /enhancement/:id/submit`                        |
| 5    | Status panel             | "Enhancement submitted"                        | SSE                                                    |
| 6    | Approval                 | "Enhancement approved — ₹1,50,000 added"       | SSE                                                    |

---

## J-04 — NHCX final claim submission

**Trigger**: Patient discharged.

| Step | Screen                       | Action                                                    | Endpoint                                              |
|------|------------------------------|-----------------------------------------------------------|-------------------------------------------------------|
| 1    | Case detail                  | Click "Initiate Discharge"                                | `POST /discharge/initiate`                            |
| 2    | Discharge form               | Final bill amount, discharge summary, OT notes, etc.      | `PATCH /discharge/:id`                                |
| 3    | Document checklist           | Upload all required docs (per-payer rules engine)         | `POST /documents` × N                                 |
| 4    | Completeness check           | Platform shows green/red checklist; blocks if incomplete  | `GET /discharge/:id/checklist`                        |
| 5    | Submit discharge to NHCX     | (NHCX has a discharge step)                               | `POST /discharge/:id/submit`                          |
| 6    | Final claim form             | Itemized bill, totals                                     | `POST /claim/draft`                                   |
| 7    | Submit claim                 | Submit                                                     | `POST /claim/:id/submit`                              |
| 8    | Status panel                 | "Claim submitted"                                          | SSE                                                    |
| 9    | Outcome                      | Approved / Query / Rejected                                | SSE                                                    |

---

## J-05 — NHCX reimbursement claim

**Trigger**: Patient has paid out-of-pocket and is filing for reimbursement after discharge. Different from cashless: no preauth phase; claim phase only.

| Step | Screen                  | Action                                                 | Endpoint                                              |
|------|--------------------------|--------------------------------------------------------|-------------------------------------------------------|
| 1    | Cases list               | New Case → Reimbursement                               | `POST /cases`                                         |
| 2    | Patient + policy capture | Same as J-01 steps 2–5                                 |                                                       |
| 3    | Reimbursement form       | All bills, reports, discharge summary                  | `POST /claim/draft?type=reimbursement`                |
| 4    | Documents                | Upload everything                                      | `POST /documents`                                     |
| 5    | Submit claim             | Submit                                                  | `POST /claim/:id/submit`                              |
| 6    | Outcome                  | Approval / Query / Reject                              | SSE                                                    |

---

## J-06 — PMJAY preauth (assist mode, v1 default)

**Persona**: Pradhan Mantri Arogya Mitra (PMAM)
**Trigger**: PMJAY beneficiary admitted for a treatment listed in HBP.

| Step | Screen                       | Action                                                    | Endpoint                                              |
|------|------------------------------|-----------------------------------------------------------|-------------------------------------------------------|
| 1    | Cases list                   | "New Case" → PMJAY rail                                   | `POST /cases?rail=pmjay`                              |
| 2    | Beneficiary verification     | Enter PMJAY card / Aadhaar; system calls BIS              | `POST /pmjay/verify-beneficiary`                      |
| 3    | Family member select         | Pick the family member                                    | `POST /pmjay/select-beneficiary`                      |
| 4    | Package selection            | Search HBP; system suggests packages from diagnosis       | `GET /pmjay/packages?diagnosis=...&specialty=...`     |
| 5    | Estimate                     | System calculates package amount                          | `POST /preauth/draft?rail=pmjay`                      |
| 6    | Document checklist           | Upload required documents                                 | `POST /documents`                                     |
| 7    | Assist mode launcher         | "Submit on PMJAY portal — we've prepared the values"      | `GET /pmjay/assist-payload/:preauthId`                |
| 8    | Side panel with values       | Copy-paste values into PMJAY portal                       | (no API call)                                         |
| 9    | Reference number capture     | Paste the PMJAY reference back                            | `POST /preauth/:id/portal-confirm`                    |
| 10   | Status: PREAUTH_SUBMITTED    | Now tracked as if API submitted                           | SSE                                                    |
| 11   | Outcome                      | PMAM checks PMJAY portal periodically; updates status     | `POST /preauth/:id/portal-update` (manual update form)|

**Note**: in v2, steps 7–11 collapse into a single submit when auto mode is active.

---

## J-07 — PMJAY claim submission (assist mode)

Similar to J-06 with claim form instead of preauth.

---

## J-08 — PMJAY query handling

| Step | Screen                  | Action                                              | Endpoint                                              |
|------|--------------------------|-----------------------------------------------------|-------------------------------------------------------|
| 1    | Notification             | "PMJAY query raised"                                | SSE / email                                          |
| 2    | Query detail             | Read query (PMAM enters from portal manually)       | `POST /preauth/:id/queries` (manual entry)            |
| 3    | Response draft           | Compose response                                     | `POST /preauth/:id/queries/:queryId/draft`            |
| 4    | Document attach          | Add supporting docs                                 | `POST /documents`                                     |
| 5    | Submit                   | Submit on portal (assist) or API (when available)   | `POST /preauth/:id/queries/:queryId/respond`          |

---

## J-09 — Claim denial and appeal

| Step | Screen                  | Action                                              | Endpoint                                              |
|------|--------------------------|-----------------------------------------------------|-------------------------------------------------------|
| 1    | Denial notification      | Modal: "Claim rejected — reason: documentation incomplete" | SSE                                            |
| 2    | Denial detail            | View denial reasons, payer comments                 | `GET /claim/:id/rejection`                            |
| 3    | Appeal initiation        | "Initiate Appeal"                                   | `POST /claim/:id/appeal`                              |
| 4    | Appeal form              | Enter rebuttal, attach additional evidence          | `PATCH /claim/:id/appeal/:appealId`                   |
| 5    | Submit appeal            | Submit                                               | `POST /claim/:id/appeal/:appealId/submit`             |
| 6    | Outcome                  | Resolved (won / lost)                                | SSE                                                    |

---

## J-10 — Settlement and reconciliation

**Persona**: Billing manager (could also be desk executive)

| Step | Screen                       | Action                                                 | Endpoint                                              |
|------|------------------------------|--------------------------------------------------------|-------------------------------------------------------|
| 1    | Settlement queue             | List of CLAIM_APPROVED + PAYMENT_PENDING claims        | `GET /settlement?status=payment_pending`              |
| 2    | Bank statement upload        | Upload bank statement / NEFT advice                    | `POST /settlement/bank-statement` (multipart)         |
| 3    | Auto-match                   | System matches NEFT amounts to claims                  | (background job, no UI action)                        |
| 4    | EOB upload                   | Upload TPA EOB PDF                                     | `POST /settlement/:id/eob`                            |
| 5    | LLM-parsed EOB               | View extracted line items                              | `GET /settlement/:id/eob/parsed`                      |
| 6    | Discrepancy flag             | "Approved ₹3,80,000 / Received ₹3,42,000 / Deducted ₹38,000" | `GET /settlement/:id/discrepancy`              |
| 7    | Short-pay reason capture     | Categorise deductions                                  | `POST /settlement/:id/discrepancy/categorize`         |
| 8    | Decision                     | Accept / Appeal / Write-off                             | `POST /settlement/:id/decision`                       |

---

## J-11 — Billing manager: AR review and SLA escalation

| Step | Screen                  | Action                                              | Endpoint                                              |
|------|--------------------------|-----------------------------------------------------|-------------------------------------------------------|
| 1    | AR dashboard             | View claims by aging bucket                          | `GET /analytics/ar-ageing`                            |
| 2    | SLA breaches             | List of breached or at-risk claims                   | `GET /analytics/sla-status`                           |
| 3    | Reassign                 | Reassign a claim to a different executive            | `POST /claim/:id/assign`                              |
| 4    | Bulk follow-up           | Send batch follow-up emails to TPA                   | `POST /claim/bulk-followup`                           |

---

## J-12 — Doctor: clinical justification

**Trigger**: Insurance desk executive sends a signature request via SMS / email link.

| Step | Screen                  | Action                                              | Endpoint                                              |
|------|--------------------------|-----------------------------------------------------|-------------------------------------------------------|
| 1    | Email / SMS              | Click link                                          | (deeplink)                                            |
| 2    | OTP verification         | Enter OTP                                            | `POST /auth/doctor-otp` (no JWT)                      |
| 3    | Preauth review           | View patient, diagnosis, justification              | `GET /preauth/:id?token=...`                          |
| 4    | Edit justification       | Optional: refine clinical narrative                 | `PATCH /preauth/:id/clinical-justification`           |
| 5    | Sign                     | Click "Sign" — captures timestamp + identifier       | `POST /preauth/:id/sign`                              |
| 6    | Confirmation             | "Signed. Insurance desk notified."                   |                                                        |

The doctor's session is short-lived and scoped to the specific preauth.

---

## J-13 — CFO analytics

| Step | Screen                  | Action                                              | Endpoint                                              |
|------|--------------------------|-----------------------------------------------------|-------------------------------------------------------|
| 1    | Dashboard                | Overview cards: total claims, AR, denial rate       | `GET /analytics/overview`                             |
| 2    | Drill into denials       | Per-payer denial reason breakdown                    | `GET /analytics/denials?groupBy=payer`                |
| 3    | Drill into TAT           | Per-payer turnaround time                            | `GET /analytics/tat?groupBy=payer`                    |
| 4    | Package profitability    | PMJAY package-wise margin                            | `GET /analytics/pmjay-packages`                       |
| 5    | Cash flow forecast       | Pipeline: PAYMENT_PENDING expected payments          | `GET /analytics/cash-forecast`                        |
| 6    | Export                   | Download CSV/Excel                                   | `GET /analytics/export?report=...`                    |

---

## J-14 — Admin: tenant setup

**Persona**: Hospital admin or platform onboarding rep

| Step | Screen                  | Action                                              | Endpoint                                              |
|------|--------------------------|-----------------------------------------------------|-------------------------------------------------------|
| 1    | Tenant create (platform admin) | Create tenant                                | `POST /admin/tenants`                                 |
| 2    | NHCX setup               | Enter HFR ID, NHCX participant code, upload cert    | `POST /admin/tenants/:id/nhcx`                        |
| 3    | PMJAY setup              | Enable PMJAY, set state (MP)                        | `POST /admin/tenants/:id/pmjay`                       |
| 4    | Branding                 | Upload logo, set colors                              | `POST /admin/tenants/:id/branding`                    |
| 5    | First admin user         | Create hospital admin                                | `POST /admin/tenants/:id/users`                       |
| 6    | Roles                    | Configure roles (insurance_desk_exec, billing_manager, ...) | `POST /admin/tenants/:id/roles`              |
| 7    | Payer config             | Enable/disable payers from master                    | `POST /admin/tenants/:id/payers`                      |
| 8    | Document checklist       | Override default checklist if needed                | `POST /admin/tenants/:id/document-checklist`          |
| 9    | Send invite              | Email + SMS to first admin                          | `POST /admin/tenants/:id/users/:userId/invite`        |

---

## J-15 — Patient OTP and consent

**Trigger**: Insurance desk needs patient consent for NHCX/ABDM data sharing.

| Step | Screen / channel        | Action                                              | Endpoint                                              |
|------|--------------------------|-----------------------------------------------------|-------------------------------------------------------|
| 1    | Insurance desk           | Click "Capture Consent"                             | `POST /consent/initiate`                              |
| 2    | SMS to patient           | "Consent OTP: 1234"                                 | (TextGuru via Notification module)                    |
| 3    | Patient                  | Reads OTP to executive (verbal) OR taps a link      | (link option opens a one-page consent screen)         |
| 4    | OTP verify               | Executive enters; or patient enters on link         | `POST /consent/verify`                                |
| 5    | Consent recorded         | `ConsentRecord` row created with evidence           | (no UI action)                                        |

---

## J-16 — System: ABHA verification flow

(Background, automated; user only sees status updates)

1. New patient with declared ABHA address → system queues `abdm.verify-abha`.
2. Worker calls ABDM verification API.
3. Result stored on `Patient` row; consent timestamps captured.
4. SSE notifies frontend of verification outcome.

---

## J-17 — Scheduled SLA breach alerts

(Cron-driven, no user action)

1. `sla.evaluate` cron runs every 5 minutes.
2. Finds claims where `currentSlaDeadline < NOW() + INTERVAL '24 hours'` and status is not terminal.
3. Updates `claim.slaState = 'AT_RISK'`.
4. Pushes notification to assigned executive (in-app + email).
5. Same for breach.

---

## Endpoint conventions (cross-cutting)

### Auth headers

```
Authorization: Bearer <jwt>
X-Tenant-Id: <tenantUuid>
X-Idempotency-Key: <client-generated UUID for POSTs>
```

`X-Tenant-Id` is verified against the JWT's tenant claim — mismatch → 403.

### Standard responses

**Success** — 200 / 201 / 202 / 204 with body or empty.

**Error** — RFC 7807 Problem Details:

```json
{
  "type": "https://claims.digisparsh.in/errors/PREAUTH_NOT_FOUND",
  "title": "Pre-authorization not found",
  "status": 404,
  "code": "PREAUTH_NOT_FOUND",
  "detail": "No pre-authorization with ID 91d... exists in this tenant",
  "correlationId": "01HX...",
  "instance": "/api/v1/preauth/91d.../submit"
}
```

The `code` field is what the frontend uses to look up modal copy.

### Pagination

```
GET /resource?page=1&pageSize=20&sortBy=createdAt&sortDir=desc
```

Response:
```json
{
  "data": [...],
  "page": 1,
  "pageSize": 20,
  "total": 235,
  "totalPages": 12
}
```

### Filtering

Query parameters use a small DSL:
```
GET /claims?status=PREAUTH_SUBMITTED,PREAUTH_QUERY_RAISED&payerId=abc&assignedTo=me
```

`assignedTo=me` is a magic value resolved server-side from the JWT.

### Real-time

Server-Sent Events at `GET /cases/:id/events` for live updates per case. WebSocket is overkill for v1.

### Idempotency

Every mutating endpoint accepts `X-Idempotency-Key`. Duplicate requests within 24 hours return the original response.

### Rate limiting

100 req/min per user, 1000 req/min per tenant. Higher limits configurable per tenant. Burst handling via Redis token bucket.

### Versioning

URL-based: `/api/v1/...`. Breaking changes go in `/api/v2/...`. v1 stays supported for ≥12 months after v2 ships.
