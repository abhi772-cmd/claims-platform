# 04 — State Machines

This doc maps every status a claim can be in, every transition, and how NHCX and PMJAY differ underneath while presenting the same status terminology to the user. Every status here corresponds to a constant in `apps/api/src/modules/claim/claim.status.ts` and a label/color in `apps/web/lib/claim/status-labels.ts`.

The status state machine is the most-referenced doc on the team. Memorize it.

---

## Top-level claim status (unified across rails)

The user-facing status is the same for both rails. Internal sub-statuses differ. The frontend displays the top-level status with a small rail badge ("NHCX" or "PMJAY") next to it.

```
INITIATED                   The case is created. No payer interaction yet.
ELIGIBILITY_CHECK_PENDING   Insurance plan / coverage eligibility being verified.
ELIGIBILITY_VERIFIED        Patient is eligible. Ready for preauth.
ELIGIBILITY_FAILED          Verification failed; user must correct or abandon.

PREAUTH_DRAFTING            Executive is filling the preauth form.
PREAUTH_QUEUED              Preauth is queued for outbound submission.
PREAUTH_SUBMITTED           Sent to payer; awaiting initial response.
PREAUTH_QUERY_RAISED        Payer has raised a query; executive must respond.
PREAUTH_QUERY_RESPONDED     Response sent; awaiting payer's next action.
PREAUTH_APPROVED            Approved with the indicated amount.
PREAUTH_REJECTED            Rejected. Reason stored.
PREAUTH_PARTIALLY_APPROVED  Approved with a different amount than requested.

ENHANCEMENT_DRAFTING        Mid-stay enhancement being drafted.
ENHANCEMENT_QUEUED          Outbound enhancement queued.
ENHANCEMENT_SUBMITTED       Enhancement sent.
ENHANCEMENT_APPROVED        Approved.
ENHANCEMENT_REJECTED        Rejected.

DISCHARGE_PENDING           Patient discharged in HIS; documentation pending.
DISCHARGE_SUBMITTED         Discharge bundle sent (NHCX) or document set complete (PMJAY).

CLAIM_DRAFTING              Final claim being assembled.
CLAIM_QUEUED                Claim queued for outbound submission.
CLAIM_SUBMITTED             Claim sent to payer.
CLAIM_QUERY_RAISED          Payer raised a query on the claim.
CLAIM_QUERY_RESPONDED       Response sent.
CLAIM_APPROVED              Claim approved by payer.
CLAIM_REJECTED              Claim rejected.
CLAIM_PARTIALLY_APPROVED    Approved at a lesser amount.

PAYMENT_PENDING             Approved; awaiting payer's payment.
PAYMENT_RECEIVED            Payment hit our bank account; awaiting reconciliation.
PAYMENT_RECONCILED          EOB matched against received payment.
SHORT_PAID                  Received less than approved; investigation needed.
WRITTEN_OFF                 Closed at a loss; deduction reasons recorded.

APPEAL_INITIATED            Hospital is appealing a denial / short-pay.
APPEAL_SUBMITTED            Appeal sent to payer.
APPEAL_RESOLVED             Appeal completed (either way).

CLOSED                      Terminal. No further action.
ABANDONED                   Hospital chose to stop pursuing.
```

That's 35 statuses. The state machine covers all of them.

---

## State transition diagram (top-level)

```
                                   ┌──────────────┐
                                   │  INITIATED   │
                                   └──────┬───────┘
                                          │
                                          ▼
                          ┌────────────────────────────┐
                          │ ELIGIBILITY_CHECK_PENDING  │
                          └─────┬───────────────┬──────┘
                                │               │
                                ▼               ▼
                  ┌─────────────────┐  ┌──────────────────┐
                  │ ELIGIBILITY_    │  │ ELIGIBILITY_     │
                  │ VERIFIED        │  │ FAILED           │──→ (correct or ABANDONED)
                  └────────┬────────┘  └──────────────────┘
                           │
                           ▼
                  ┌─────────────────┐
                  │ PREAUTH_        │
                  │ DRAFTING        │
                  └────────┬────────┘
                           │
                           ▼
                  ┌─────────────────┐
                  │ PREAUTH_QUEUED  │
                  └────────┬────────┘
                           │
                           ▼
                  ┌─────────────────┐
                  │ PREAUTH_        │
                  │ SUBMITTED       │
                  └────┬─────┬──────┘
                       │     │
       ┌───────────────┘     └───────────────┐
       ▼                                     ▼
┌─────────────────┐                 ┌──────────────────┐
│ PREAUTH_QUERY_  │ ←── repeat ───→ │ PREAUTH_         │
│ RAISED          │                 │ APPROVED |       │
└────────┬────────┘                 │ REJECTED |       │
         │                          │ PARTIALLY        │
         ▼                          │ APPROVED         │
┌─────────────────┐                 └─────┬────────────┘
│ PREAUTH_QUERY_  │                       │
│ RESPONDED       │                       ▼
└────────┬────────┘                 ┌──────────────────┐
         └──────── back to ────────→│ (next: enhance / │
                  PREAUTH_SUBMITTED │ discharge / claim)│
                                    └──────────────────┘

(Enhancement, discharge, claim, payment, appeal flows follow similar patterns —
 see full transition table below.)
```

A single claim moves through a sequence; the platform shows whichever stage is current as the headline status.

---

## Full transition table

Format: `from → to (event_type, allowed_for_rails, side_effect)`

### Eligibility phase

| From                      | To                          | Event                          | Rails       | Side effect                         |
|---------------------------|-----------------------------|--------------------------------|-------------|--------------------------------------|
| —                         | INITIATED                   | case.created                   | both        | New `claim` row                      |
| INITIATED                 | ELIGIBILITY_CHECK_PENDING   | eligibility.requested          | both        | Outbound NHCX/BIS call queued        |
| ELIGIBILITY_CHECK_PENDING | ELIGIBILITY_VERIFIED        | eligibility.verified           | both        | —                                    |
| ELIGIBILITY_CHECK_PENDING | ELIGIBILITY_FAILED          | eligibility.failed             | both        | Modal raised; reason captured        |
| ELIGIBILITY_FAILED        | ELIGIBILITY_CHECK_PENDING   | eligibility.retry              | both        | New attempt                          |
| ELIGIBILITY_FAILED        | ABANDONED                   | case.abandoned                 | both        | —                                    |

### Preauth phase

| From                       | To                             | Event                             | Rails       | Side effect                          |
|----------------------------|--------------------------------|-----------------------------------|-------------|---------------------------------------|
| ELIGIBILITY_VERIFIED       | PREAUTH_DRAFTING               | preauth.drafting_started          | both        | —                                     |
| PREAUTH_DRAFTING           | PREAUTH_QUEUED                 | preauth.submitted_internally      | both        | pg-boss `nhcx.send-preauth` job, OR pmjay assist task created |
| PREAUTH_QUEUED             | PREAUTH_SUBMITTED              | preauth.acknowledged_by_payer     | both        | NHCX gateway returned correlation_id; PMJAY assist marks "submitted in portal" |
| PREAUTH_QUEUED             | PREAUTH_DRAFTING               | preauth.submission_failed         | both        | Retry budget exhausted; modal raised |
| PREAUTH_SUBMITTED          | PREAUTH_QUERY_RAISED           | preauth.query_received            | both        | Notification to assigned executive   |
| PREAUTH_SUBMITTED          | PREAUTH_APPROVED               | preauth.approved                  | both        | Approved amount set; SLA timer for next phase started |
| PREAUTH_SUBMITTED          | PREAUTH_REJECTED               | preauth.rejected                  | both        | Reason stored                         |
| PREAUTH_SUBMITTED          | PREAUTH_PARTIALLY_APPROVED     | preauth.partially_approved        | both        | Approved amount set < requested      |
| PREAUTH_QUERY_RAISED       | PREAUTH_QUERY_RESPONDED        | preauth.query_responded           | both        | Outbound communication sent          |
| PREAUTH_QUERY_RESPONDED    | PREAUTH_APPROVED               | preauth.approved                  | both        | —                                     |
| PREAUTH_QUERY_RESPONDED    | PREAUTH_QUERY_RAISED           | preauth.query_received            | both        | Another query (rare but happens)     |
| PREAUTH_QUERY_RESPONDED    | PREAUTH_REJECTED               | preauth.rejected                  | both        | —                                     |
| PREAUTH_QUERY_RESPONDED    | PREAUTH_PARTIALLY_APPROVED     | preauth.partially_approved        | both        | —                                     |
| PREAUTH_REJECTED           | APPEAL_INITIATED               | appeal.started                    | both        | Appeal flow opens                    |
| PREAUTH_REJECTED           | ABANDONED                      | case.abandoned                    | both        | —                                     |
| PREAUTH_PARTIALLY_APPROVED | ENHANCEMENT_DRAFTING           | enhancement.drafting_started      | both        | If hospital wants top-up             |
| PREAUTH_PARTIALLY_APPROVED | DISCHARGE_PENDING              | discharge.initiated               | both        | If hospital accepts the partial      |
| PREAUTH_APPROVED           | ENHANCEMENT_DRAFTING           | enhancement.drafting_started      | both        | —                                     |
| PREAUTH_APPROVED           | DISCHARGE_PENDING              | discharge.initiated               | both        | —                                     |

### Enhancement phase (mid-stay top-up)

| From                       | To                              | Event                             | Rails        | Side effect                          |
|----------------------------|---------------------------------|-----------------------------------|--------------|---------------------------------------|
| PREAUTH_APPROVED           | ENHANCEMENT_DRAFTING            | enhancement.drafting_started      | both         | —                                     |
| ENHANCEMENT_DRAFTING       | ENHANCEMENT_QUEUED              | enhancement.submitted_internally  | both         | Outbound queued                      |
| ENHANCEMENT_QUEUED         | ENHANCEMENT_SUBMITTED           | enhancement.acknowledged          | both         | —                                     |
| ENHANCEMENT_SUBMITTED      | ENHANCEMENT_APPROVED            | enhancement.approved              | both         | Approved amount added                 |
| ENHANCEMENT_SUBMITTED      | ENHANCEMENT_REJECTED            | enhancement.rejected              | both         | —                                     |
| ENHANCEMENT_APPROVED       | DISCHARGE_PENDING               | discharge.initiated               | both         | —                                     |
| ENHANCEMENT_REJECTED       | DISCHARGE_PENDING               | discharge.initiated               | both         | —                                     |

### Discharge → Claim phase

| From                  | To                       | Event                         | Rails       | Side effect                          |
|-----------------------|--------------------------|-------------------------------|-------------|---------------------------------------|
| (any approved state)  | DISCHARGE_PENDING        | discharge.initiated           | both        | Document checklist activated         |
| DISCHARGE_PENDING     | DISCHARGE_SUBMITTED      | discharge.submitted           | both        | NHCX: discharge bundle sent. PMJAY: docs uploaded |
| DISCHARGE_SUBMITTED   | CLAIM_DRAFTING           | claim.drafting_started        | both        | —                                     |
| CLAIM_DRAFTING        | CLAIM_QUEUED             | claim.submitted_internally    | both        | —                                     |
| CLAIM_QUEUED          | CLAIM_SUBMITTED          | claim.acknowledged            | both        | —                                     |
| CLAIM_SUBMITTED       | CLAIM_QUERY_RAISED       | claim.query_received          | both        | —                                     |
| CLAIM_SUBMITTED       | CLAIM_APPROVED           | claim.approved                | both        | —                                     |
| CLAIM_SUBMITTED       | CLAIM_REJECTED           | claim.rejected                | both        | —                                     |
| CLAIM_SUBMITTED       | CLAIM_PARTIALLY_APPROVED | claim.partially_approved      | both        | —                                     |
| CLAIM_QUERY_RAISED    | CLAIM_QUERY_RESPONDED    | claim.query_responded         | both        | —                                     |
| CLAIM_QUERY_RESPONDED | CLAIM_APPROVED           | claim.approved                | both        | —                                     |
| CLAIM_QUERY_RESPONDED | CLAIM_REJECTED           | claim.rejected                | both        | —                                     |
| CLAIM_QUERY_RESPONDED | CLAIM_PARTIALLY_APPROVED | claim.partially_approved      | both        | —                                     |

### Payment / settlement phase

| From                     | To                  | Event                       | Rails       | Side effect                              |
|--------------------------|---------------------|-----------------------------|-------------|-------------------------------------------|
| CLAIM_APPROVED           | PAYMENT_PENDING     | payment.expected            | both        | SLA timer for payment                    |
| CLAIM_PARTIALLY_APPROVED | PAYMENT_PENDING     | payment.expected            | both        | —                                         |
| PAYMENT_PENDING          | PAYMENT_RECEIVED    | payment.received            | both        | Bank reconciliation captured             |
| PAYMENT_RECEIVED         | PAYMENT_RECONCILED  | payment.reconciled          | both        | EOB parsed and matched                   |
| PAYMENT_RECEIVED         | SHORT_PAID          | payment.short_paid          | both        | Reasons captured                         |
| PAYMENT_RECONCILED       | CLOSED              | claim.closed                | both        | Terminal                                  |
| SHORT_PAID               | APPEAL_INITIATED    | appeal.started              | both        | Appeal flow                              |
| SHORT_PAID               | WRITTEN_OFF         | claim.written_off           | both        | Loss recorded                            |
| WRITTEN_OFF              | CLOSED              | claim.closed                | both        | Terminal                                  |
| CLAIM_REJECTED           | APPEAL_INITIATED    | appeal.started              | both        | —                                         |
| CLAIM_REJECTED           | WRITTEN_OFF         | claim.written_off            | both        | —                                         |

### Appeal phase

| From                  | To                  | Event                       | Rails       | Side effect                              |
|-----------------------|---------------------|-----------------------------|-------------|-------------------------------------------|
| APPEAL_INITIATED      | APPEAL_SUBMITTED    | appeal.submitted            | both        | Outbound communication                  |
| APPEAL_SUBMITTED      | APPEAL_RESOLVED     | appeal.resolved             | both        | Resolution captured                     |
| APPEAL_RESOLVED       | PAYMENT_PENDING     | payment.expected            | both        | If appeal won                           |
| APPEAL_RESOLVED       | WRITTEN_OFF         | claim.written_off           | both        | If appeal lost                          |

---

## How NHCX and PMJAY differ inside these transitions

**The status is the same. The mechanism is different.**

### Eligibility verification

- **NHCX**: Insurance plan request + Coverage eligibility check (FHIR R4 messages to NHA gateway). Async. Two correlation IDs chained.
- **PMJAY**: BIS API call with PMJAY card / family ID. Synchronous. Single response.

The user sees: a single "Verify Eligibility" button. The router decides which integration runs.

### Preauth submission

- **NHCX**: Build FHIR `Claim` Bundle with `use=preauthorization`. JWE encrypt. POST to `/preauth/submit`. Async; response arrives via callback. One correlation chain.
- **PMJAY (api mode, when available)**: POST to TMS preauth endpoint. Synchronous response.
- **PMJAY (assist mode, v1 default)**: Platform shows a checklist with pre-filled fields. Executive submits in PMJAY portal manually. Comes back, pastes the reference number into the platform. Status moves from PREAUTH_QUEUED to PREAUTH_SUBMITTED with `mode=assist`.
- **PMJAY (manual mode)**: Same as assist but without pre-filled checklist. Executive does it themselves and updates status.
- **PMJAY (auto mode, v2)**: Playwright automation submits via portal; trace captured.

The user sees: a single "Submit Pre-auth" CTA. Sub-text adapts: "Sending to NHCX..." or "Open PMJAY portal — we've prepared the values you need."

### Query response

- **NHCX**: Inbound `communication.on_request` message. Outbound `communication.request` reply. Bundle-based.
- **PMJAY (api)**: API call.
- **PMJAY (assist/manual)**: Platform shows the query text and prepared response; executive enters in portal.

UI: same "Query received" panel. Same "Respond" button.

### Claim submission

- **NHCX**: `claim.submit` Bundle. Includes itemized bills, discharge summary references, etc.
- **PMJAY**: Document bundle assembly + portal submission (assist) or API call (where available).

UI: same flow, same documents checklist, same submit CTA.

### Payment notice

- **NHCX**: Asynchronous `paymentnotice.request` callback or active polling.
- **PMJAY**: Bank reconciliation against expected NHA disbursement; EOB downloaded from portal manually (assist) until v2 automation.

---

## SLA tracking

A separate `claim.slaState` field tracks SLA health independent of status:

- `ON_TRACK` — within SLA, no action needed
- `AT_RISK` — within 24h of SLA breach
- `BREACHED` — past SLA

The cron job `sla.evaluate` runs every 5 minutes. Per-payer SLA windows are configured in the `Payer` master.

---

## UI status mapping

`apps/web/lib/claim/status-labels.ts` exports:

```ts
export const STATUS_LABEL: Record<ClaimStatus, string> = {
  INITIATED: 'Initiated',
  ELIGIBILITY_CHECK_PENDING: 'Eligibility Check',
  ELIGIBILITY_VERIFIED: 'Eligible',
  ELIGIBILITY_FAILED: 'Eligibility Failed',
  PREAUTH_DRAFTING: 'Pre-auth (Draft)',
  PREAUTH_QUEUED: 'Pre-auth Queued',
  PREAUTH_SUBMITTED: 'Pre-auth Submitted',
  PREAUTH_QUERY_RAISED: 'Query Raised',
  PREAUTH_QUERY_RESPONDED: 'Query Responded',
  PREAUTH_APPROVED: 'Pre-auth Approved',
  PREAUTH_REJECTED: 'Pre-auth Rejected',
  PREAUTH_PARTIALLY_APPROVED: 'Partially Approved',
  // ... and so on
};

export const STATUS_COLOR: Record<ClaimStatus, ColorToken> = {
  INITIATED: 'neutral',
  ELIGIBILITY_CHECK_PENDING: 'info',
  ELIGIBILITY_VERIFIED: 'success-soft',
  ELIGIBILITY_FAILED: 'danger-soft',
  PREAUTH_QUEUED: 'info-soft',
  PREAUTH_SUBMITTED: 'primary',
  PREAUTH_QUERY_RAISED: 'warning',
  PREAUTH_APPROVED: 'success',
  PREAUTH_REJECTED: 'danger',
  PREAUTH_PARTIALLY_APPROVED: 'accent',
  CLAIM_APPROVED: 'success',
  PAYMENT_RECEIVED: 'success-soft',
  PAYMENT_RECONCILED: 'success',
  SHORT_PAID: 'warning',
  WRITTEN_OFF: 'neutral',
  CLOSED: 'neutral',
  ABANDONED: 'neutral',
  // ... full table
};
```

Color tokens map to the design system tokens — see `docs/09-design-system.md`.

---

## How to add a new status

1. Add the constant to `apps/api/src/modules/claim/claim.status.ts`.
2. Update this doc — add it to the status list and the transition table.
3. Add the label and color to `apps/web/lib/claim/status-labels.ts`.
4. Add the transition rule to `apps/api/src/modules/claim/claim.state-machine.ts`.
5. Add transition tests in `claim.state-machine.spec.ts`.
6. If the status implies a new error path, add the error code to `reference/error-codes.md`.

CI validates that every status in the enum has a matching label, color, and transition rule.

---

## Validation: invariants the state machine guarantees

- A claim cannot skip from `INITIATED` to `PREAUTH_APPROVED` in one transition.
- `PREAUTH_QUERY_RAISED` must be preceded by `PREAUTH_SUBMITTED` (or another `PREAUTH_QUERY_RESPONDED`).
- `CLOSED` and `ABANDONED` are terminal — no outbound transitions.
- Once `PAYMENT_RECONCILED`, the claim cannot return to a non-terminal state without an explicit appeal flow.
- The materialised `claim.status` always equals the most recent `claim_event`'s resulting state (verified by a periodic consistency check job).
