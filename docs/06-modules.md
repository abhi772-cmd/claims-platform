# 06 — Module Breakdown

Each module is a NestJS `@Module()` with its own controllers, services, schemas, and tests. Modules expose services to other modules; they never reach into another module's repository or Prisma client directly.

---

## Patient & Policy Intake

**Owns**: Patient identity, ABHA linkage, insurance policy capture, PMJAY beneficiary verification.

**Responsibilities**:
- Search/lookup patient from HIS via integration adapter
- Create / update patient record with encrypted PII
- Capture insurance policy with NHCX `insurancePlan` request
- Verify ABHA address via ABDM
- PMJAY beneficiary lookup via BIS API

**Key services**: `PatientService`, `PolicyService`, `PmjayBeneficiaryService`, `AbhaService`.

**Key endpoints**: `POST /patients/lookup`, `POST /patients`, `PATCH /patients/:id`, `POST /policies`, `POST /pmjay/verify-beneficiary`.

**External calls**: HIS API, NHCX `insurancePlan`, ABDM, BIS API.

---

## Pre-authorization Engine

**Owns**: Preauth lifecycle from drafting to approval/rejection/query handling.

**Responsibilities**:
- Diagnosis coding (ICD-10, ICHI)
- Procedure coding (NHA billing codes, HBP for PMJAY)
- PMJAY package selection assistant — suggests packages from diagnosis + procedure
- Cost estimation (per package or itemized for NHCX)
- Document attachment and checklist enforcement
- Doctor signature workflow
- Outbound submission (NHCX FHIR or PMJAY assist/api)
- Query/response threading

**Key services**: `PreauthService`, `PreauthQueryService`, `PackageSuggestionService`.

**Key endpoints**: `POST /preauth/draft`, `PATCH /preauth/:id`, `POST /preauth/:id/submit`, `POST /preauth/:id/queries/:queryId/respond`, `POST /preauth/:id/sign`.

---

## Enhancement, Discharge, Claim

These three modules share patterns. Enhancement is a top-up during stay. Discharge is a NHCX-specific message + a document set for both rails. Claim is the final settlement-eligible submission.

**Key services**: `EnhancementService`, `DischargeService`, `ClaimService`.

**Key endpoints**:
- `POST /enhancement/draft`, `POST /enhancement/:id/submit`
- `POST /discharge/initiate`, `POST /discharge/:id/submit`
- `POST /claim/draft`, `POST /claim/:id/submit`, `GET /claim/:id`

---

## Communication & Tracking

**Owns**: Query/response threading, status timeline, SLA timers, notifications.

**Responsibilities**:
- Inbound NHCX `communication` callback handling
- Outbound `communication` reply
- PMJAY query capture (manual entry in v1)
- Per-case timeline view (all events in chronological order)
- SLA timer evaluation per payer config
- Real-time push to UI via SSE

**Key services**: `CommunicationService`, `TimelineService`, `SlaEvaluatorService`, `RealtimeService`.

**Key endpoints**: `GET /cases/:id/timeline`, `GET /cases/:id/events` (SSE), `GET /cases/:id/sla`.

---

## Settlement & Reconciliation

**Owns**: Payment receipt logging, EOB parsing, deduction reasoning, short-payment workflow, appeal initiation.

**Responsibilities**:
- Bank statement upload and NEFT matching
- EOB PDF upload and LLM-based extraction (OpenAI)
- Discrepancy classification (per-payer deduction taxonomy)
- Short-payment decision tree (Accept / Appeal / Write-off)
- Appeal lifecycle

**Key services**: `SettlementService`, `EobParseService`, `ReconciliationService`, `AppealService`.

**Key endpoints**: `POST /settlement/bank-statement`, `POST /settlement/:id/eob`, `GET /settlement/:id/discrepancy`, `POST /settlement/:id/decision`, `POST /claim/:id/appeal`.

---

## Analytics

**Owns**: Read-only reporting on top of the transactional data via materialized views.

**Responsibilities**:
- Denial reason analytics (per payer, per package, per executive)
- TPA-wise turnaround time
- Package-wise margin (PMJAY)
- Executive productivity (claims handled, avg time to submit)
- AR ageing buckets
- Cash flow forecasting from PAYMENT_PENDING pipeline

**Key services**: `AnalyticsService` (read-only queries against MVs).

**Materialized views**:
- `mv_claim_aging` (refreshed every 15 min)
- `mv_denial_reasons` (refreshed hourly)
- `mv_payer_tat` (refreshed hourly)
- `mv_pmjay_package_margin` (refreshed daily)
- `mv_cash_forecast` (refreshed every 30 min)

**Key endpoints**: `GET /analytics/overview`, `GET /analytics/denials`, `GET /analytics/tat`, `GET /analytics/ar-ageing`, `GET /analytics/cash-forecast`, `GET /analytics/export`.

---

## Document Storage

**Owns**: Document upload, storage, retrieval, virus scanning.

**Responsibilities**:
- Multipart upload streaming directly to OVH Object Storage
- ClamAV scan via async worker
- Per-document-type metadata (preauth_form, OT_notes, EOB, etc.)
- Per-payer checklist enforcement (call-back from preauth/claim modules)
- Presigned URL generation for download

**Key services**: `DocumentService`, `VirusScanService`, `ChecklistService`.

**Key endpoints**: `POST /documents` (multipart), `GET /documents/:id` (returns presigned URL), `DELETE /documents/:id`.

---

## Notification

**Owns**: Email and SMS dispatch with templating.

**Channels**:
- Email — Nodemailer (SMTP)
- SMS — TextGuru API
- In-app — stored in DB, fetched by frontend

**Templates** (versioned, in `apps/api/src/modules/notification/templates/`):
- `preauth_approved`, `preauth_rejected`, `query_received`, `claim_approved`, `payment_received`, `sla_at_risk`, `sla_breached`, `doctor_signature_request`, `consent_otp`, `password_reset`, `user_invitation`, `mfa_otp`.

**Key services**: `NotificationService`, `TemplateService`.

**Key endpoints**: `POST /notifications/preview` (admin), `GET /notifications/:userId/inbox`.

---

## Integrations gateway

Sub-modules:

### NHCX integration

**Ported from**: DigiNode `authservices/src/services/nhcxService.ts`, `nhcxApiService.ts`, `nhcxfunctions.ts`.

**Owns**:
- Session token management
- JWE encryption / decryption
- FHIR Bundle generation (per message type)
- JWE signing (X.509 cert per HFR facility)
- Outbound message submission
- Inbound callback decryption + routing

**Key services**: `NhcxService`, `NhcxBundleBuilder`, `NhcxCallbackHandler`.

### PMJAY integration

**Owns**:
- Beneficiary verification (BIS API)
- Package master sync
- Mode router (api / auto / assist / manual)
- Assist payload generator (pre-fills fields for executive to copy)
- Future: YAML flow executor for auto mode (v2)

**Key services**: `PmjayService`, `BisService`, `PackageMasterService`, `ModeRouter`.

### ABDM integration

**Owns**: ABHA verification, HFR lookups, HPR lookups (for doctors).

**Key services**: `AbdmService`.

### Shared integration utilities

- `IntegrationMessageRepository` — persists every external call
- `RetryWithBackoff` — exponential backoff
- `CircuitBreaker` — per-integration breaker
- `IdempotencyKeyService` — generates/checks keys

---

## Admin

**Owns**: Tenant CRUD, user management, RBAC, master data, audit access.

**Responsibilities**:
- Platform admin endpoints (cross-tenant; require platform admin role)
- Tenant admin endpoints (within-tenant; require tenant admin role)
- Payer master, package master, ICD/billing code masters

**Key services**: `TenantService`, `UserAdminService`, `RoleService`, `PayerMasterService`, `PackageMasterService`.

**Key endpoints**: `POST /admin/tenants`, `POST /admin/tenants/:id/users`, `POST /admin/payers`, `POST /admin/packages/sync` (re-syncs HBP master).

---

## Auth

**Owns**: Login, JWT issuance, refresh tokens, MFA, password reset, doctor short-lived tokens.

**Responsibilities**:
- Username/password login (Argon2 hash)
- JWT (15-minute access tokens, 7-day refresh tokens)
- MFA (TOTP)
- Password reset email flow
- Doctor signature short-lived token (10-minute lifetime, scoped to one preauth)

**Key services**: `AuthService`, `JwtService`, `MfaService`.

**Key endpoints**: `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/mfa/enroll`, `POST /auth/mfa/verify`, `POST /auth/password-reset`, `POST /auth/doctor-otp`.

---

## Audit

**Owns**: Append-only audit log, audit query interface for compliance.

**Responsibilities**:
- Capture every CREATE / UPDATE / DELETE / VIEW / EXPORT on sensitive resources
- Capture login / logout / failed login
- Provide query interface for tenant admins to see their own audit data
- Export audit logs for IRDAI / NHA inspections

**Key services**: `AuditService`, `AuditQueryService`.

**Key endpoints**: `GET /audit?resourceType=...&resourceId=...`, `GET /audit/export?from=...&to=...`.

---

## Health

**Owns**: Health check endpoints for liveness/readiness.

- `GET /health/live` — basic process up
- `GET /health/ready` — DB connection, Redis, queue depth check
- `GET /health/version` — git SHA, build time

---

## Module dependency rules

```
Allowed imports:

auth ← (everything authenticated)
tenant ← (everything tenant-aware)

patient → policy → preauth → enhancement → claim → settlement
case orchestrates all the above

integrations.nhcx ← preauth, enhancement, discharge, claim, settlement
integrations.pmjay ← preauth, claim, query
integrations.abdm ← patient, policy

audit ← (everything writes)
notification ← (everything dispatches)
document ← preauth, claim, settlement, query
analytics → (read-only against materialized views)

admin → tenant, user, payer-master, package-master
```

ESLint rule enforces this via `eslint-plugin-boundaries`.

---

## What "module-complete" looks like

A module is shipped when:
- All listed services have unit tests with coverage above gate.
- Public service methods have JSDoc explaining the contract.
- All endpoints appear in OpenAPI.
- All errors map to `reference/error-codes.md`.
- Integration tests cover at least the happy path.
- The module's responsibilities and endpoint list in this doc are accurate.
