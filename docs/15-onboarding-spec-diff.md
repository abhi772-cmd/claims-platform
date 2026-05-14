# 15 — Onboarding flow: spec-vs-implementation diff

Source spec (handed off 2026-05-13): the "Stage 1–7" ops-assisted + hospital
self-service onboarding flow. This document maps each stage of that spec onto
what already exists in [docs/14](14-onboarding-and-auth.md) + the running code,
and calls out every new contract, schema, endpoint, table, and UI surface that
would be required to close the gap.

Scope: design diff only. No code, no migrations. Once an entry below is
accepted, it gets a sprint slot and a `feat/onboarding-…` branch of its own.

---

## At-a-glance status

| Stage from spec | Coverage | Lift |
|---|---|---|
| 1. Lead capture + tenant provisioning | Partial — endpoint exists, field set thinner | S — extend `tenant` columns + admin form |
| 1b. Auto-generated subdomain | Missing | M — needs host-based tenant resolver |
| 2. Primary admin activation + MFA + progress tracker | Done | — |
| 3. KYC & legal upload + ops review queue + SLA | Missing entirely | L — new entities + new ops surface |
| 4. ABDM/NHCX participant onboarding (ops-on-behalf) | Partial — data-entry today, no API call to NHA | M |
| 4b. ABDM M1/M2 milestone gate for prod | Missing | S — readiness extension |
| 5. Cryptographic setup (KMS keypair + sandbox handshake) | Partial — step exists; KMS + handshake outstanding | M |
| 6. Bridge URL configuration (per-tenant callback) | Step exists | S — wire to gateway |
| 7. User & role provisioning (catalog of 8 roles) | Done | — |

S = ≤1 sprint, M = 1–2 sprints, L = 2+ sprints.

---

## Stage 1 — Lead capture & tenant provisioning

### What spec asks for
Ops-only super-admin form capturing:
- Hospital **legal name**
- **ROHINI ID**
- **Type** (private / trust / govt / PSU)
- **Bed count**
- **HMIS in use** (Birlamedisoft, Akhil, MediXcel, custom, …)
- **Expected claims volume** (monthly band)
- **Primary contact** (name, designation, email, mobile)

System auto-generates:
- Tenant UUID
- **Subdomain** `apollo-indore.digisparsh.io`
- Invite token for primary admin

### What exists today
- `POST /admin/tenants` exists ([docs/14](14-onboarding-and-auth.md) step 3).
- `tenant_profile` step in [onboarding.schema.ts:60-65](../packages/contracts/src/onboarding.schema.ts) captures: `legalName`, `GSTIN`, `NHCX/PMJAY enablement flags`, `primaryContact`.
- No ROHINI ID, hospital type, bed count, HMIS, or claims-volume fields.
- No subdomain field on `tenant` — host is fixed.

### Gap → required changes

| Change | Where |
|---|---|
| Extend `tenant_profile` capture set | `packages/contracts/src/tenant.schema.ts` — add `rohiniId`, `hospitalType` (enum `private`/`trust`/`govt`/`psu`), `bedCount`, `hmisVendor`, `expectedMonthlyVolume` (enum band: `<100`, `100-500`, `500-2000`, `2000+`) |
| Persist | `tenant` table — additive columns; migration must default existing rows |
| Surface in tenant_profile step UI | `apps/web/app/(dashboard)/admin/onboarding/page.tsx` — wizard sub-form |
| Update step descriptor `captures[]` | `onboarding.schema.ts:63` |
| Subdomain auto-gen | New column `tenant.subdomain` (unique), generator using slug from legal name + collision suffix |
| Host-based tenant resolver | `apps/api/src/common/middleware/tenant-resolver.middleware.ts` (currently session-scoped) — read `Host` header, fall back to session for the bare app domain |
| DNS wildcard | Infra-side, OVH DNS — `*.digisparsh.io` → ingress |

Risk: subdomain routing intersects with cookie scope. Decide upfront whether the auth cookie is set on `.digisparsh.io` (cross-subdomain) or per-tenant subdomain (no cross-tenant leak surface). Likely the latter, but it forces the platform-admin portal onto a separate host (`admin.digisparsh.io`).

---

## Stage 3 — KYC & legal (largest missing slice)

### What spec asks for
Hospital uploads:
- Hospital registration certificate
- ROHINI registration proof
- GST certificate
- PAN
- Authorized signatory ID
- Cancelled cheque (for settlements)

Digital signature on:
- DPA (DPDP Act compliant)
- MSA

Goes into ops review queue. Nothing downstream unlocks until ops marks KYC verified. **Soft SLA of 48 hours** surfaced in UI.

### What exists today
Single `legal_acceptance` step ([onboarding.schema.ts:132-138](../packages/contracts/src/onboarding.schema.ts)): one boolean acknowledgement, no file uploads, no ops review.

### Gap → required changes

**New entity: `kyc_document`**

```prisma
model KycDocument {
  id                 String   @id @default(uuid()) @db.Uuid
  tenantId           String   @db.Uuid
  documentType       KycDocumentType
  storageKey         String                // OVH object-storage key
  filename           String
  contentType        String
  sizeBytes          Int
  sha256             String                // integrity at rest
  uploadedByUserId   String   @db.Uuid
  uploadedAt         DateTime @default(now())
  reviewStatus       KycReviewStatus  @default(pending)
  reviewedByUserId   String?  @db.Uuid    // platform admin who acted
  reviewedAt         DateTime?
  reviewNotes        String?
  rejectionReasonCode String?              // structured for analytics
  // RLS: tenant_admin can SELECT/INSERT own-tenant rows; platform_admin can SELECT all + UPDATE reviewStatus

  @@index([tenantId, documentType])
  @@index([reviewStatus, uploadedAt])      // ops queue
}

enum KycDocumentType {
  hospital_registration
  rohini_registration
  gst_certificate
  pan
  signatory_id
  cancelled_cheque
  dpa_signed
  msa_signed
}

enum KycReviewStatus {
  pending
  approved
  rejected
  resubmission_requested
}
```

**New contracts**

`packages/contracts/src/kyc.schema.ts`:
- `KycDocumentTypeSchema`, `KycReviewStatusSchema`
- `KycDocumentSchema` (response shape; redact storageKey from non-platform-admin callers — return signed URL only)
- `UploadKycDocumentRequestSchema` — multipart, single file at a time
- `ReviewKycDocumentRequestSchema` — `{ action: 'approve'|'reject'|'request_resubmission', notes?, rejectionReasonCode? }`
- `KycSummarySchema` — what the tenant sees on the wizard step (`{ documentType, status, reviewedAt? }[]`, plus `slaState: 'on_track' | 'breaching' | 'breached'`)

**New endpoints**

Tenant-facing (`/tenant`):
- `GET /tenant/kyc` → `KycSummary`
- `POST /tenant/kyc/upload` (multipart) → `KycDocument`
- `DELETE /tenant/kyc/:id` (only while `pending`)

Ops-facing (`/admin`):
- `GET /admin/kyc/queue?status=pending` — paginated, sorted by `uploadedAt`
- `GET /admin/kyc/:id` → full record + signed download URL
- `POST /admin/kyc/:id/review` → `ReviewKycDocumentRequest`

**New onboarding step keys** (replacing the single `legal_acceptance`):
- `kyc_documents_uploaded` — blocks NHCX cutover
- `legal_agreements_signed` (DPA + MSA) — blocks NHCX cutover
- `kyc_verified_by_ops` — derived/auto-completed when all docs `approved` + agreements signed; cannot be marked complete by hospital

**E-signature**

V1 decision needed: do we DocuSign / eMudhra / e-Sign Aadhaar? Recommend a thin abstraction `LegalSignatureProvider` with a stub adapter for v1 (hospital downloads PDF, re-uploads signed) and a real adapter slot for v2. Keeps the data model honest without blocking on a vendor pick.

**SLA surfacing**

Add `sla_target_hours` column on `KycDocument` (default 48). The summary endpoint computes `slaState` from `uploadedAt + sla_target_hours` vs now. UI shows it as an amber/red banner on the wizard step + in the ops queue.

**Lifecycle gate**

Extend the `IN_SETUP → PILOT` transition guard in [tenant-lifecycle.service.ts](../apps/api/src/modules/onboarding/tenant-lifecycle.service.ts) to require `kyc_verified_by_ops = completed`. Add a matching readiness check item.

**Storage**

OVH object storage, server-side encrypted, bucket-per-tenant or single bucket + `tenant/<uuid>/kyc/<docId>` path prefix. Signed URLs with 5-min TTL for downloads. Do NOT expose raw object keys via API.

---

## Stage 4 — ABDM/NHCX participant onboarding

### What spec asks for
- Hospital provides **Facility HPR ID** (or ops helps register on HPR)
- Ops **initiates NHCX participant registration via the participant API on behalf of the hospital** — capturing participant code (`<code>@hcx`), role (`provider`), endpoint URLs
- For **production tenants**, validate **ABDM M1/M2 milestone readiness** before this stage — flag any gaps explicitly

### What exists today
- `hfr_facility` step exists — manual entry of HFR ID + screenshot evidence.
- `nhcx_participant_code` step — manual entry of the `@hcx` code already issued by NHA.
- No API call to NHA's participant registration API; current model assumes the hospital already opened a ticket with NHA out-of-band.
- No M1/M2 milestone tracking.

### Gap → required changes

**1. HPR ID is a separate field from HFR ID**

Today, the `hfr_facility` step descriptor mentions only HFR. HPR is the *health professional* registry (doctor identity), distinct from HFR (facility). The spec conflates these — clarify which is meant:
- If "Facility HPR ID" is a typo for HFR ID → no change, current step covers it.
- If it really means an HPR-linked facility account → new field `hprFacilityAccountId` on the step, distinct from `hfrFacilityId`.

Assume the former until product confirms.

**2. NHCX participant API client**

Today's flow is a data-entry placeholder. The spec wants ops to call NHA's participant API. Required:

- New module `apps/api/src/modules/nhcx-participant/` with a thin client wrapping the NHA participant onboarding endpoint(s).
- Outbound call logged into `integration_message` (CLAUDE.md rule 7).
- Encrypts and stores any returned credentials (e.g. participant secret if NHA issues one) in the KMS-wrapped secret column.

New endpoints:
- `POST /admin/tenants/:id/nhcx/register-participant` — ops triggers the call, body carries the role + endpoint URLs to register.
- `GET /admin/tenants/:id/nhcx/participant-status` — read-back from NHA registry.

**3. ABDM M1/M2 milestone readiness**

NHA's production-gating milestones aren't currently modelled. Add:

- New table `abdm_milestone_check`:
  ```
  id, tenantId, milestoneKey, status, evidenceRef, recordedByUserId, recordedAt
  ```
  Milestones: `m1_audit_passed`, `m2_security_audit_passed`, `integration_tests_passed`.
- New onboarding step `abdm_milestones` — applies only when target lifecycle is `LIVE` (sandbox `PILOT` doesn't require it).
- Readiness check: when target = LIVE, fail readiness if any M1/M2 milestone ≠ `passed`.
- Step UI shows each milestone with a "How to evidence" link.

---

## Stage 5 — Cryptographic setup

### What spec asks for
- Generate **RSA-2048 (or 3072)** keypair per tenant, stored in **KMS/HSM, never exported**
- Push public key to NHCX participant registry via the `fetchPublicKey` write path
- Configure bridge URL (callback endpoint, namespaced per tenant, e.g. `/callback/{tenant_id}/on_request`)
- Run a **sandbox handshake**: `searchParticipant` + dummy `InsurancePlan` round-trip with a test payer. Wizard shows green when handshake succeeds.

### What exists today
- `nhcx_cert` step captures fingerprint + KMS-wrapped private-key reference (as data fields).
- `nhcx_callback_url` step captures the URL.
- OVH KMS integration is on the open-items list (memory: `claims_platform_status` says v1 launch still needs OVH KMS + production deploy).
- No sandbox-handshake automation.

### Gap → required changes

| Item | Change |
|---|---|
| KMS-backed keygen | Wire up `KmsService` (currently a stub per memory). New endpoint `POST /admin/tenants/:id/nhcx/generate-keypair` — server-side keygen, private key never leaves KMS, public key returned for submission |
| Public-key push to NHA | Extend `nhcx-participant` client (Stage 4 item 2) with `submitPublicKey` operation. Auto-mark `nhcx_cert` complete on 2xx from NHA |
| Sandbox handshake | New module `apps/api/src/modules/nhcx-handshake/` — runs `searchParticipant` + `InsurancePlan/$discover` against NHCX sandbox. Persists last-run result on `tenant_nhcx_handshake_check` table (`status`, `ranAt`, `failureReason`) |
| Wizard "green tick" | `nhcx_cert` and `nhcx_callback_url` step evidence is auto-set when handshake passes. Readiness item `nhcxRoundTripPassed` flips to ok |
| New onboarding step `nhcx_handshake` | Explicit step (currently implicit). Replaces the docs/14 readiness-only check. Blocks NHCX cutover |

---

## Stages 2, 6, 7 — Already covered

| Stage | Coverage notes |
|---|---|
| 2. Primary admin activation (MFA + progress tracker) | accept-invite + MFA enrollment shipped ([docs/14 Part 2](14-onboarding-and-auth.md)); wizard progress is the onboarding page itself |
| 6 (implied — bridge URL) | `nhcx_callback_url` step exists; the per-tenant namespacing (`/callback/{tenantId}/on_request`) is already how the gateway routes |
| 7. User & role provisioning | All 8 roles seeded ([seed.ts:27](../apps/api/prisma/seed.ts)); `roles_assigned` step requires Admin + Claims Maker + Claims Checker before NHCX cutover |

---

## Lifecycle-state implications

The spec's "ops review queue" + "ABDM M1/M2 gate" tightens the transition rules in [04-state-machines.md](04-state-machines.md). Proposed additions:

| Transition | New guard |
|---|---|
| `PROVISIONING → IN_SETUP` | No change (still ops action) |
| `IN_SETUP → PILOT` | Add: all KYC docs `approved`, DPA + MSA signed, NHCX sandbox handshake passed |
| `PILOT → LIVE` | Add: M1 + M2 ABDM milestones `passed`, integration tests `passed` |

These are platform-admin-gated transitions today; the new readiness items just make the failure modes explicit instead of relying on ops memory.

---

## Suggested slice order

If we accept this diff, ship in this order — each slice is a single PR, each one self-contained:

1. **Tenant profile field extension** (S) — additive columns, no behaviour change. Safe to ship first.
2. **KYC document model + tenant upload UI** (M) — without ops review yet. Hospital can upload; status shows `pending`.
3. **KYC ops review queue + lifecycle gate** (M) — completes the Stage 3 story. Pilot transitions start respecting KYC verification.
4. **NHCX participant API client + ops-on-behalf registration** (M) — Stage 4 automation.
5. **KMS keypair + sandbox handshake automation** (M) — Stage 5; depends on KMS integration finally landing (the production-deploy open item).
6. **ABDM M1/M2 milestone tracking** (S) — readiness extension; needed before any LIVE transition.
7. **Subdomain routing** (M, optional v1.5) — biggest blast radius; can ship after the rest if customers don't need it on day one.

Slices 1–3 alone close the largest visible gap (KYC + ops review). 4–5 close the NHCX automation gap. 6 closes the production-readiness gap. 7 is cosmetic-to-customers but architectural for us.

---

## Open product questions

1. **E-signature vendor** for DPA + MSA — DocuSign, eMudhra, e-Sign Aadhaar, or thin "download/upload signed PDF" stub for v1?
2. **Subdomain scope** — `*.digisparsh.io` cross-subdomain cookie, or per-tenant cookie + separate `admin.digisparsh.io` host? (Recommend the latter.)
3. **HPR vs HFR** — is the spec's "Facility HPR ID" really HFR, or do we need a distinct field?
4. **KYC SLA** — 48 hours is soft. Should breach trigger anything beyond UI banner (Slack alert to ops, escalation email)?
5. **NHA participant API contract stability** — has NHA published a stable schema for the participant onboarding API, or do we need the integration to be retry-tolerant against a moving target? Affects how defensive the client needs to be.
