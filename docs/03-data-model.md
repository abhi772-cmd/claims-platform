# 03 — Data Model

This doc explains the core entities, the multi-tenancy scheme, and the event-sourcing pattern for the claim aggregate. The Prisma schema lives at `apps/api/prisma/schema.prisma`; this doc explains the why.

---

## Schema layout principles

1. **Every tenant-scoped table has a `tenantId String` column** plus an RLS policy.
2. **Every row has `createdAt`, `updatedAt`, and `createdById` / `updatedById`** (FK to `User`).
3. **Soft delete via `deletedAt`** — physical deletes happen only via the audit-archival job for rows beyond retention.
4. **Master data is versioned**, not overwritten — `effectiveFrom`, `effectiveTo` columns on `Payer`, `Package`, `IcdCode`, etc.
5. **The claim aggregate is event-sourced** — `Claim` holds materialised state, `ClaimEvent` is the append-only log of truth.
6. **Document binaries never live in Postgres** — only references (`storageKey`, `bucket`, `etag`) in `Document` rows; binaries in OVH Object Storage.
7. **PII fields encrypted at rest** with `pgcrypto` symmetric encryption, key fetched per-tenant from OVH KMS at app start.

---

## Core entities (logical, not exhaustive)

### Tenant and user

```
Tenant
  id, name, slug, displayName, logoUrl, branding, status, createdAt
  hfrFacilityId, nhcxParticipantCode, nhcxEnabled, pmjayEnabled
  defaultStateForPmjay (e.g., "MP")
  config: JsonB  (per-tenant feature flags, document checklist overrides)

User
  id, tenantId, email, mobile, passwordHash, status,
  firstName, lastName, designation,
  lastLoginAt, mfaEnabled, mfaSecret(enc)

Role
  id, tenantId, name (e.g., "insurance_desk_executive", "billing_manager"),
  permissions: JsonB  (declarative permission list)

UserRole  (M:N)
  userId, roleId

TenantConfig
  tenantId, key, value: JsonB, updatedAt, updatedById
  // Per-tenant feature flags, document checklists, payer rules, etc.
```

### Patient and policy

```
Patient
  id, tenantId, hospitalMrn, firstName(enc), lastName(enc), dob(enc),
  gender, mobile(enc), email(enc), abhaId(enc), abhaAddress,
  emergencyContact, address: JsonB(enc),
  consentFlags: JsonB,  // patient consent for NHCX, ABDM, PMJAY
  createdAt, updatedAt

InsurancePolicy
  id, tenantId, patientId, payerId, policyNumber(enc),
  memberId(enc), planName, sumInsured, validFrom, validTo,
  relationToPolicyHolder, policyHolderName(enc),
  policyStatus, sourcePayload: JsonB

PmjayBeneficiary
  id, tenantId, patientId, pmjayCardNumber(enc), familyId(enc),
  stateScheme,        // "PMJAY", "MP-AB-NIRAMAYAM", state schemes co-existing
  verificationMethod, // "biometric", "otp", "ekyc"
  verifiedAt, verificationPayload: JsonB
```

### Case and claim

A **case** is the top-level container. One hospital admission can produce multiple claims (e.g., NHCX cashless + later reimbursement, or PMJAY + state scheme split).

```
Case
  id, tenantId, patientId, hospitalMrn, admissionDate, admissionType,
  treatingDoctorId (FK to User), referredBy,
  caseStatus,         // "open", "closed", "abandoned"
  primaryRail,        // "nhcx" | "pmjay" | "self_pay"
  createdAt, closedAt

Claim
  id, tenantId, caseId, rail (enum: nhcx, pmjay),
  status,             // see state machine doc
  status_substatus,   // for granular UI
  payerId,
  policyId (nullable, for nhcx),
  pmjayBeneficiaryId (nullable, for pmjay),
  packageCode (nullable, for pmjay),
  preauthAmount, claimAmount, approvedAmount, paidAmount,
  preauthRefNum, claimRefNum, payerRefNum,
  initiatedAt, submittedAt, approvedAt, paidAt, closedAt,
  currentSlaDeadline, slaState,  // "on_track", "at_risk", "breached"
  assignedToUserId,   // current desk executive
  metadata: JsonB

ClaimEvent  (APPEND ONLY — RLS denies UPDATE/DELETE)
  id, tenantId, claimId, eventType, eventVersion,
  occurredAt, recordedAt, recordedById,
  payload: JsonB,     // full event data
  correlationId,      // links to integration_message
  prevEventId         // chain pointer for efficient replay
```

`Claim` is the materialised view. `ClaimEvent` is the source of truth. Reconstructing a claim's state from events is a service method, not a code-path used in hot reads, but it is used for disputes and for rebuilding the materialised view if we ever need to.

### NHCX-specific

```
NhcxBundle
  id, tenantId, claimId, messageType,  // insurance, coverage, preauth, claim, ...
  correlationId, requestId,
  ourBundle: JsonB,                     // the FHIR Bundle we sent
  bundleResponse: JsonB,                // what came back
  status,                               // "sent", "acknowledged", "responded", "failed"
  sentAt, respondedAt
  
  Indices: (claimId, messageType), (correlationId)
```

### PMJAY-specific

```
PmjaySubmission
  id, tenantId, claimId, operation,        // "preauth", "claim", "query_response"
  mode,                                     // "api", "auto", "assist", "manual"
  state,                                    // "MP", etc.
  flowVersion (nullable, for auto mode),
  status,
  submittedAt, completedAt,
  payload: JsonB,
  result: JsonB,
  traceUrl                                  // OVH Object Storage key for Playwright trace (auto mode)

PmjayAutomationRun  (only for mode="auto" — created in v2)
  id, submissionId, workerHost, browserVersion, flowVersion,
  startedAt, endedAt, screenshotUrls: String[], failureClass
```

### Documents

```
Document
  id, tenantId, claimId, documentType,    // "discharge_summary", "investigation_report", "implant_sticker", "OT_notes", "preauth_form", "EOB", ...
  storageBucket, storageKey, etag,
  contentType, sizeBytes, originalFilename,
  uploadedAt, uploadedById,
  virusScanStatus, virusScanCompletedAt,
  metadata: JsonB
```

### Integration gateway

```
IntegrationMessage  (every external call, in and out)
  id, tenantId, claimId (nullable),
  direction,        // "outbound" | "inbound"
  integration,      // "nhcx" | "pmjay_tms" | "abdm" | "openai" | "textguru" | "smtp"
  operation,        // "send_preauth", "callback_received", etc.
  correlationId, idempotencyKey,
  status,           // "pending", "sent", "succeeded", "failed", "circuit_open"
  failureClass,     // "network", "auth", "validation", "server_5xx", "captcha", "selector"
  rawRequest: JsonB,
  rawResponse: JsonB,
  retryCount, lastAttemptAt,
  createdAt, completedAt
```

### Master data (versioned)

```
Payer  (TPAs, insurers, NHA for PMJAY)
  id, tenantId (nullable — shared masters are tenantId NULL),
  type,          // "tpa" | "insurer" | "nha"
  name, code, nhcxParticipantCode (nullable),
  effectiveFrom, effectiveTo, version

Package  (PMJAY HBP packages, with versioning)
  id, code, name, specialty, hbpVersion,
  amount, complications, exclusions: JsonB,
  effectiveFrom, effectiveTo

IcdCode  (ICD-10 with M, G, P, C codes — same shape as DigiNode's existing schema)
  id, m_code, m_desc, g_code, g_desc, p_code, p_desc, c_code, c_desc,
  active, effectiveFrom, effectiveTo

BillingCode  (NHA-defined, ported from DigiNode)
  id, code, system, display, inactive

DocumentChecklistRule  (per payer + claim type)
  id, tenantId (nullable), payerId, claimType, documentType,
  required, condition: JsonB,  // e.g., "required if cardiac surgery"
  effectiveFrom, effectiveTo
```

### Audit and consent

```
AuditLog  (append-only — RLS denies UPDATE/DELETE)
  id, tenantId, occurredAt, actorUserId,
  actorType,    // "user" | "system" | "scheduled"
  action,       // "created", "updated", "viewed", "exported", "deleted"
  resourceType, resourceId, before: JsonB, after: JsonB,
  ipAddress, userAgent, correlationId

ConsentRecord
  id, tenantId, patientId, consentType,    // "nhcx_processing", "abdm_data_share", "pmjay_processing", "marketing"
  grantedAt, revokedAt, version, evidence: JsonB
  // evidence: OTP delivery proof, signed PDF reference, video consent, etc.
```

### Notifications

```
Notification
  id, tenantId, recipientType,    // "user" | "patient"
  recipientUserId, recipientPatientId,
  channel,                         // "email" | "sms" | "in_app"
  templateKey, templateData: JsonB,
  status,                          // "queued", "sent", "delivered", "failed"
  sentAt, deliveredAt, failureReason
```

### Settlement

```
Settlement
  id, tenantId, claimId,
  paymentMode,        // "cashless_tpa", "patient_oop", "reimbursement", "pmjay_disbursement"
  expectedAmount, receivedAmount, deductionAmount, deductions: JsonB,
  receivedAt, eobDocumentId (FK to Document),
  reconciliationStatus,  // "auto_matched", "manual_match_pending", "short_paid", "discrepancy"
  shortPaymentReasons: JsonB
```

---

## RLS — how it actually works

For every tenant-scoped table:

```sql
ALTER TABLE claim ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON claim
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_insert ON claim
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_update ON claim
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_delete ON claim
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true));
```

Plus a "platform admin" role bypass:

```sql
CREATE POLICY platform_admin_bypass ON claim
  FOR ALL
  USING (current_setting('app.role', true) = 'platform_admin');
```

The application's connection role is `claims_app_user` — which does not have the `BYPASSRLS` attribute. Even a SQL injection that bypasses Prisma cannot cross tenants.

The app sets the GUC at the start of every transaction:

```sql
SET LOCAL app.tenant_id = '<uuid>';
SET LOCAL app.role = 'tenant';   -- or 'platform_admin' for ops tooling
```

CI test enforces the policy: a test that opens a transaction with tenant A's GUC and queries a row created under tenant B expects zero rows.

---

## Audit and event-sourcing tables — append-only enforcement

```sql
CREATE POLICY claim_event_no_update ON claim_event
  FOR UPDATE USING (false);

CREATE POLICY claim_event_no_delete ON claim_event
  FOR DELETE USING (false);
```

Same for `audit_log`. Application code that tries to UPDATE either is silently rejected.

---

## Partitioning for retention

`claim_event`, `audit_log`, `integration_message`, and `notification` are partitioned monthly using `pg_partman`. Hot (current month + previous 3) lives on the primary; older partitions can be detached and archived to OVH Object Storage as parquet for the 7-year retention window without bloating active storage.

---

## Encryption strategy

PII fields use `pgcrypto`'s symmetric encryption (`PGP_SYM_ENCRYPT` / `PGP_SYM_DECRYPT`). The key:
- Is per-tenant (different tenants use different keys, so a key compromise is bounded).
- Is wrapped by an OVH KMS master key.
- Is fetched once at app start, decrypted via KMS, kept in memory only.

Field-level convention: any column suffixed `(enc)` in the schema docs means it's encrypted. Reads go through a Prisma extension that decrypts on materialisation.

For very-high-sensitivity fields (Aadhaar, biometric data — though we shouldn't store these), use envelope encryption with per-row data keys. Out of scope for v1 since we don't store these.

---

## Soft delete and retention

`deletedAt` marks rows as soft-deleted. Application reads filter on `deletedAt IS NULL` by default. Audit access reads include soft-deleted rows.

A daily job:
- Moves rows with `deletedAt < NOW() - INTERVAL '7 years'` to cold storage and physical-deletes from the primary.
- For DPDP "right to erasure" requests, marks the patient and all related rows for accelerated deletion (subject to IRDAI 7-year retention floor — DPDP's right doesn't override sectoral retention).

---

## Indices and performance

Primary indices on every FK. Plus:

```
claim:                  (tenant_id, status, current_sla_deadline)
                        (tenant_id, assigned_to_user_id, status)
                        (tenant_id, payer_id, submitted_at) for analytics
claim_event:            (claim_id, occurred_at)
                        partitioned by month
integration_message:    (correlation_id)
                        (tenant_id, integration, status, created_at)
                        partitioned by month
nhcx_bundle:            (correlation_id)
                        (claim_id, message_type)
patient:                (tenant_id, hospital_mrn) UNIQUE
                        (tenant_id, abha_address) where abha_address IS NOT NULL
document:               (claim_id, document_type)
audit_log:              (tenant_id, resource_type, resource_id)
                        (tenant_id, occurred_at)
                        partitioned by month
```

---

## Master data versioning pattern

When PMJAY publishes a new HBP version:

1. Don't update existing rows.
2. Set `effectiveTo = <new version effective date>` on currently-active rows.
3. Insert new rows with `effectiveFrom = <new version effective date>`, `effectiveTo = NULL`.

A claim filed under HBP 2022 stays linked to the 2022-version `Package` row forever, so historical re-rendering is correct.

Application reads at a specific point in time use:

```ts
where: { effectiveFrom: { lte: claim.submittedAt }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: claim.submittedAt } }] }
```

---

## Migrations

- Generated by `prisma migrate dev`.
- Reviewed in PRs.
- Applied in CI to a fresh test DB before integration tests.
- Applied in production via `prisma migrate deploy` — never `db push`.
- Each migration is reversible where possible (a separate down-migration if not).
- Migrations that change RLS policies require a `-- MANUAL: verify cross-tenant test passes` comment and a CI gate.

---

## Seeds

Seed data (in `apps/api/prisma/seed.ts`):
- Master payer list (Medi Assist, Paramount, FHPL, Health India, etc.)
- ICD-10 codes (port from DigiNode's existing seed)
- Billing codes (port from DigiNode)
- PMJAY HBP packages (latest version)
- Document checklist rules (per major payer)
- Default tenant + admin user for local dev
- Default roles and permissions

```bash
pnpm db:seed   # runs prisma/seed.ts
```

---

## What "the data model is right" looks like

- Every claim transition writes a `claim_event` and never updates `claim.status` directly.
- Every external call writes both directions to `integration_message`.
- Every soft-delete leaves the row queryable via the audit context.
- Every cross-tenant read attempt returns zero rows.
- The claim's current state can be reconstructed from `claim_event` alone.
- PII fields appear `***` in `SELECT *` for any user without the decrypt role.
