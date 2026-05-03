# 14 — Hospital Onboarding and Authentication

This doc covers two related but distinct surfaces: how a hospital becomes a paying tenant on the platform, and how individual users authenticate and authorize once the tenant is live.

---

## Part 1 — Hospital onboarding lifecycle

### Tenant lifecycle states

A tenant moves through these states. The `tenant.lifecycleState` column drives what works:

```
LEAD              Sales-tracked only. No platform record yet.
CONTRACTED        Contract signed. Platform record provisioned but inactive.
PROVISIONING     Platform admin is configuring the tenant; no end-user access yet.
IN_SETUP         First admin user invited; setup wizard in progress.
PILOT             Active but capped — sandbox NHCX, limited claim count.
LIVE              Production. All features active.
SUSPENDED         Temporarily blocked (non-payment, security incident, customer pause).
CHURNED           Closed. Read-only audit access for retention period.
```

Allowed transitions:

```
LEAD          → CONTRACTED
CONTRACTED    → PROVISIONING
PROVISIONING  → IN_SETUP
IN_SETUP      → PILOT          (after setup wizard complete + sanity checks)
IN_SETUP      → LIVE           (skip-pilot path for established hospitals)
PILOT         → LIVE
PILOT         → SUSPENDED
LIVE          → SUSPENDED
SUSPENDED     → LIVE
SUSPENDED     → CHURNED
LIVE          → CHURNED
```

Transitions are RBAC-gated: only platform admins can move a tenant to/from `LIVE`, `SUSPENDED`, `CHURNED`. Hospital-side admins can self-progress through `IN_SETUP → PILOT` once the wizard is complete.

### What each state allows

| State        | Login | NHCX outbound | PMJAY outbound | Reports | Notes |
|--------------|-------|---------------|----------------|---------|-------|
| LEAD         | —     | —             | —              | —       | No record yet |
| CONTRACTED   | ❌    | ❌            | ❌             | ❌      | Sales handoff in progress |
| PROVISIONING | ❌    | ❌            | ❌             | ❌      | Platform admin configuring |
| IN_SETUP     | ✅ admin only | ❌      | ❌             | ❌      | Setup wizard active |
| PILOT        | ✅    | ✅ sandbox     | ✅ assist only | ✅      | Capped claims |
| LIVE         | ✅    | ✅ production  | ✅             | ✅      | Full access |
| SUSPENDED    | ❌    | ❌            | ❌             | ✅ read | Audit-only |
| CHURNED      | ❌    | ❌            | ❌             | ✅ read | Retention period |

---

### J-18 — Hospital onboarding journey (end-to-end)

| Step | Owner                        | Action                                                                                              | Endpoint / artefact                                       |
|------|------------------------------|-----------------------------------------------------------------------------------------------------|-----------------------------------------------------------|
| 1    | Sales / CSM                  | Capture lead in CRM (out of platform)                                                              | external CRM                                              |
| 2    | Sales + Hospital             | Contract signed (DocuSign or paper)                                                                | external                                                  |
| 3    | Platform admin               | Create tenant record                                                                                | `POST /admin/tenants`                                     |
| 4    | Platform admin               | Configure billing plan, hospital metadata                                                          | `PATCH /admin/tenants/:id`                                |
| 5    | Hospital                     | Provide HFR facility ID                                                                             | UI form (or back-channel)                                 |
| 6    | Hospital                     | Provide NHCX participant code (`<id>@hcx`)                                                          | UI form                                                    |
| 7    | Platform admin + hospital    | Generate / collect X.509 certificate; encrypt and store private key                                | `POST /admin/tenants/:id/nhcx-cert`                       |
| 8    | Hospital                     | Confirm callback URL is registered at NHA (we use shared gateway URL)                              | external (NHA portal)                                     |
| 9    | Hospital                     | Confirm PMJAY empanelment status; provide state(s)                                                  | `POST /admin/tenants/:id/pmjay-config`                    |
| 10   | Hospital                     | Provide portal credentials per state (encrypted, KMS-wrapped)                                       | `POST /admin/tenants/:id/pmjay-credentials`               |
| 11   | Platform admin               | Move tenant to `IN_SETUP` and invite first admin user                                              | `POST /admin/tenants/:id/lifecycle` + `POST /admin/tenants/:id/users` |
| 12   | First admin (hospital)       | Accept invite, set password, enroll MFA                                                            | `POST /auth/accept-invite` + `POST /auth/mfa/enroll`      |
| 13   | First admin                  | Complete setup wizard (7 steps — see below)                                                        | `GET /onboarding/setup-wizard` flow                       |
| 14   | First admin                  | Invite team (insurance desk executives, billing manager, doctors, PMAMs)                           | `POST /tenant/users`                                      |
| 15   | Platform admin               | Run sanity checks — sandbox NHCX round-trip, payer master populated, document checklists OK       | `GET /admin/tenants/:id/readiness`                        |
| 16   | Platform admin + hospital    | Move to `PILOT`                                                                                    | `POST /admin/tenants/:id/lifecycle`                       |
| 17   | Hospital                     | First few real claims under support supervision                                                    | normal usage                                              |
| 18   | Platform admin               | After successful pilot (typically 30 days), move to `LIVE`                                        | `POST /admin/tenants/:id/lifecycle`                       |
| 19   | Hospital                     | Operating in production                                                                            | normal usage                                              |

Onboarding SLA: from contract signed to `IN_SETUP` is targeted at 5 working days. From `IN_SETUP` to `PILOT` depends on the hospital — wizard completion drives it. Pilot to LIVE is at least 14 days, default 30.

---

### Setup wizard (J-19)

When the first admin user logs in, they see a 7-step inline wizard. Skippable, resumable.

```
Step 1. Welcome + brand                  (verify hospital name, upload logo)
Step 2. Connect NHCX                     (verify HFR ID, participant code, cert status)
Step 3. Configure PMJAY                  (state, empanelment ID, optional portal credentials)
Step 4. Enable payers                    (tick from master list of TPAs/insurers your hospital works with)
Step 5. Document checklists              (override defaults if needed)
Step 6. Invite your team                 (email + SMS to first cohort of users)
Step 7. Test case                        (create a sandbox claim with mock data; verify it round-trips)

[Finish setup] → tenant moves to PILOT
```

Each step has a "Skip for now" option (admin can return). A persistent banner shows incomplete steps.

Endpoints:
- `GET /onboarding/setup-wizard` — current state, completed steps
- `POST /onboarding/setup-wizard/step/:stepId/complete` — mark complete
- `POST /onboarding/setup-wizard/step/:stepId/skip` — mark skipped

---

### Tenant readiness check

Before a tenant moves to PILOT or LIVE, the platform runs a readiness audit:

```ts
type ReadinessReport = {
  tenantId: string;
  ready: boolean;
  checks: {
    nhcxCertValid: boolean;          // cert not expired, key wrap intact
    nhcxRoundTripPassed: boolean;    // sandbox round-trip succeeded
    pmjayStateConfigured: boolean;
    pmjayCredentialsStored: boolean; // if relevant
    payersEnabled: number;           // at least 1
    documentChecklistsConfigured: boolean;
    firstAdminMfaEnrolled: boolean;
    setupWizardComplete: boolean;
    auditLoggingActive: boolean;
  };
};
```

`GET /admin/tenants/:id/readiness` returns this. Lifecycle transition to `LIVE` requires `ready: true`.

---

## Part 2 — Authentication and authorization

### User identity model

```
User
  id, tenantId, email, mobile,
  passwordHash (Argon2id),
  status,                  // "invited" | "active" | "suspended" | "deactivated"
  emailVerifiedAt, mobileVerifiedAt,
  mfaEnabled, mfaSecret(enc), mfaBackupCodes(enc, hashed),
  passwordChangedAt, passwordHistory(enc),  // last 5 hashes
  failedLoginAttempts, lockedUntil,
  lastLoginAt, lastLoginIp, lastLoginUserAgent,
  inviteToken, inviteTokenExpiresAt, inviteAcceptedAt,
  hprNumber (nullable, doctors only),
  hprVerifiedAt
```

V1 decision: **one user belongs to exactly one tenant**. A physical person who consults for two hospitals has two accounts. V2 may introduce account linking if customer demand emerges.

### Login methods

Tenant-configurable, defaulting to email + password + TOTP MFA:

1. **Email + password** — classic. Always available.
2. **Mobile + OTP** — for hospitals that prefer mobile-first onboarding. Configurable per-tenant.
3. **Doctor short-link** — covered separately below.

SSO (SAML / OIDC) and SCIM are v2+ when an enterprise customer requires them.

### Login flow

```
┌─ POST /auth/login { email, password } ─────────────────────────┐
│                                                                 │
├─ Bad credentials → 401 AUTH_INVALID_CREDENTIALS                │
│  (failedLoginAttempts++; if >=5 within 15 min → lockedUntil)   │
│                                                                 │
├─ Locked → 423 AUTH_ACCOUNT_LOCKED                              │
│                                                                 │
├─ IP not allowed (if tenant has allowlist) → 403 AUTH_IP_NOT_ALLOWED │
│                                                                 │
├─ MFA required → 401 AUTH_MFA_REQUIRED + ephemeral mfaToken     │
│                  ↓                                              │
│  POST /auth/mfa/verify { mfaToken, code } ─────────────────────│
│                  ↓                                              │
│  MFA bad → 401 AUTH_MFA_INVALID                                │
│  MFA OK  → continue                                             │
│                                                                 │
├─ Suspicious signal (new country, new device fingerprint, etc.) │
│  → 200 + step-up: SMS OTP confirmation                         │
│                                                                 │
└─ Success → 200 with                                             │
   { accessToken (15 min), refreshToken (7 days, rotating) }     │
```

### Refresh token rotation

- Each refresh issues a new pair (access + refresh).
- The old refresh token is invalidated.
- If an old refresh token is presented after rotation, **all sessions for that user are invalidated** (reuse detection — possible compromise).

### Concurrent sessions

- Default cap: 3 active sessions per user
- Configurable per role (e.g., admin = 1, executive = 3, doctor = 1)
- Going over cap signs out the oldest session
- User can see and revoke active sessions under Profile → Security

### Idle and absolute timeouts

- Idle: 15 min (frontend resets timer on activity; backend respects token expiry of 15 min)
- Absolute: 7 days from initial login regardless of activity
- Force re-login on password change, MFA change, role change

---

### Invitation flow

```
1. Admin creates user via POST /tenant/users { email, mobile, role }
2. System generates invite token (256-bit, URL-safe, hashed in DB)
3. Token expires in 7 days
4. System sends email (Nodemailer) and SMS (TextGuru) with link:
   https://app.claims.digisparsh.in/(auth)/accept-invite/<token>
5. User clicks link → /(auth)/accept-invite/[token]/page.tsx
6. UI calls GET /auth/invite/<token> → returns user identity preview
7. User sets password (validated against policy)
8. User enrolls MFA (forced for admin role; optional for others — configurable)
9. POST /auth/accept-invite { token, password, mfaSecret? }
10. inviteAcceptedAt set; status becomes "active"; first session created
11. If first admin → setup wizard launches automatically
```

Resend invite: `POST /tenant/users/:id/resend-invite` — generates new token, invalidates old. Rate limited 3 per day per user.

Invite expiry: returns `AUTH_INVITE_TOKEN_EXPIRED` modal with "Request new invite" CTA.

---

### Password policy

- **Length**: minimum 12 characters
- **Composition**: at least one lowercase, one uppercase, one digit, one symbol
- **Common-password check**: rejected if in the haveibeenpwned k-anonymity list (offline check, no API call)
- **History**: cannot reuse the last 5 passwords
- **Rotation**: 90 days for `tenant_admin` and `platform_admin` roles; optional for others (configurable per tenant)
- **Storage**: Argon2id, time = 3, memory = 64 MB, parallelism = 4

Frontend shows real-time strength meter and per-rule check.

---

### MFA enrollment

```
1. POST /auth/mfa/enroll → returns secret (Base32) + QR code (data URL)
2. User scans with authenticator app (Google Authenticator, Authy, Microsoft, 1Password)
3. POST /auth/mfa/verify { code } → confirms enrollment, generates 8 backup codes
4. Backup codes shown ONCE; user must download or print
5. mfaEnabled = true
```

Backup codes:
- 8 single-use codes
- Stored hashed (one-way)
- Used when authenticator unavailable
- New batch can be generated anytime (invalidates old)

Recovery if locked out:
- Backup codes (preferred)
- Admin-initiated MFA reset (audit-logged, requires email + SMS confirmation by user)

---

### Password reset

```
1. User clicks "Forgot password" on login
2. POST /auth/password-reset/initiate { email }
3. System sends email with reset link (10-min expiry)
4. User clicks → /(auth)/reset-password?token=<token>
5. POST /auth/password-reset/verify { token } → 200 if valid
6. User enters new password (validated)
7. POST /auth/password-reset/complete { token, newPassword }
8. All active sessions for this user invalidated
9. Audit log: USER_PASSWORD_RESET
```

Rate limit: 3 resets per email per 24 hours.

---

### Doctor short-token flow (J-12)

Different from the regular login because doctors are occasional users. Goal: doctor signs the clinical justification with minimal friction.

```
1. Insurance desk clicks "Request signature" on preauth
2. POST /preauth/:id/request-signature { doctorUserId }
3. System generates short-token (10-min expiry, scoped to one preauthId)
4. SMS + email to doctor with link:
   https://app.claims.digisparsh.in/(auth)/doctor-sign/<token>
5. Doctor opens link
6. Page calls GET /auth/doctor-token/<token> → returns preauth preview
7. Page shows preauth, justification draft, sign button
8. Doctor optionally edits justification: PATCH /preauth/:id/clinical-justification
9. Doctor clicks Sign:
   - Page asks for OTP (sent to doctor's mobile on link click)
   - POST /auth/doctor-otp { token, otp }
   - On verify, signature recorded with timestamp + HPR number
10. Token marked single-use; cannot be replayed
```

Doctor doesn't have a regular session; just this scoped token. After signing, redirect to a thank-you page.

---

### HPR verification for doctor accounts

When a doctor user is created:
1. Admin enters HPR registration number
2. System calls ABDM HPR API
3. If active and matches name/specialty, account is provisioned
4. `hprVerifiedAt` set
5. Re-verified every 30 days via background job
6. If HPR registration becomes inactive, doctor's signing capability is revoked (account remains for read access)

If HPR API is unavailable, admin can override with `hprVerificationOverride: true` and a justification (audit logged). For tenants in pilot mode this is more permissive; in LIVE mode platform admin approval required.

---

### Account deactivation vs deletion

**Deactivation** (default for departing employees):
- `status = "deactivated"`
- Login disabled
- Active sessions terminated
- Audit trail preserved
- Reversible: admin can reactivate

**Deletion** (DPDP request or compliance-driven):
- Hard delete of user identifiers
- Audit logs pseudonymized: identifying fields → "[REDACTED]"
- Foreign keys to user (e.g., `claim_event.recordedById`) preserved as historical record but redacted
- Cannot be undone
- Requires platform admin approval after IRDAI 7-year retention floor for any data the user touched

---

### IP allowlisting (per-tenant, optional)

Tenant admins under Admin → Security can:
- Add CIDR ranges
- Toggle enforcement on/off
- See blocked attempts in the last 30 days

Implementation: middleware on all auth-required routes. Cached per-tenant; refresh every 60s.

Fail-open if the config service is down (logged + alerted; ops decision later).

---

### Trusted devices and step-up

After successful MFA login, a "trust this device for 30 days" option sets a long-lived cookie tied to a device fingerprint. Same device + same IP → MFA skipped on subsequent logins for 30 days.

Step-up triggers (force MFA again even if device trusted):
- Login from a new country
- Sensitive operation (admin role action, lifecycle transition, role change)
- Password change attempt
- Adding a new payer or destination integration

---

## Part 3 — Roles and permissions (RBAC)

### Default roles per tenant

| Role                         | Scope          | Description                                                  |
|------------------------------|----------------|--------------------------------------------------------------|
| `platform_admin`             | cross-tenant   | DigiSparsh team only. Manages tenants, billing, master data. |
| `tenant_admin`               | one tenant     | Hospital admin. Full access to that tenant.                  |
| `billing_manager`            | one tenant     | Claim ops + AR + reconciliation + assigning to executives.   |
| `insurance_desk_executive`   | one tenant     | Pre-auth, claim, query response. The primary daily user.     |
| `pmam`                       | one tenant     | PMJAY-only flows. Limited NHCX visibility.                   |
| `doctor`                     | one tenant     | Clinical justification, signing. Read access to assigned cases. |
| `finance_viewer`             | one tenant     | CFO. Read-only analytics and finance dashboards.             |
| `read_only`                  | one tenant     | View-only across the tenant. For auditors, training, etc.    |

Custom roles: tenant admins can create custom roles by composing permissions. V1 ships with the defaults; custom roles in v1.5.

### Permission matrix (excerpt)

| Permission                    | tenant_admin | billing_manager | insurance_desk | pmam | doctor | finance_viewer | read_only |
|-------------------------------|:------------:|:---------------:|:--------------:|:----:|:------:|:--------------:|:---------:|
| user.invite                   | ✓            |                 |                |      |        |                |           |
| user.update                   | ✓            |                 |                |      |        |                |           |
| user.deactivate               | ✓            |                 |                |      |        |                |           |
| tenant.update                 | ✓            |                 |                |      |        |                |           |
| tenant.lifecycle.transition   | (limited)    |                 |                |      |        |                |           |
| payer.master.view             | ✓            | ✓               | ✓              | ✓    |        | ✓              | ✓         |
| payer.master.edit             | ✓            |                 |                |      |        |                |           |
| package.master.sync           | ✓            |                 |                |      |        |                |           |
| document_checklist.edit       | ✓            | ✓               |                |      |        |                |           |
| case.create                   | ✓            | ✓               | ✓              | ✓    |        |                |           |
| case.view                     | ✓            | ✓               | ✓              | ✓    | (assigned) | ✓          | ✓         |
| case.assign                   | ✓            | ✓               |                |      |        |                |           |
| preauth.draft                 | ✓            | ✓               | ✓              | ✓    |        |                |           |
| preauth.submit                | ✓            | ✓               | ✓              | ✓    |        |                |           |
| preauth.respond_query         | ✓            | ✓               | ✓              | ✓    |        |                |           |
| preauth.approve_internal      | ✓            | ✓               |                |      |        |                |           |
| preauth.sign_clinical          |              |                 |                |      | ✓      |                |           |
| claim.draft                   | ✓            | ✓               | ✓              | ✓    |        |                |           |
| claim.submit                  | ✓            | ✓               | ✓              | ✓    |        |                |           |
| settlement.upload_eob         | ✓            | ✓               |                |      |        |                |           |
| settlement.categorize_deduct  | ✓            | ✓               | ✓              |      |        |                |           |
| settlement.appeal             | ✓            | ✓               | ✓              | ✓    |        |                |           |
| settlement.write_off          | ✓            | ✓               |                |      |        |                |           |
| analytics.view                | ✓            | ✓               | (own)          | (own)|        | ✓              | ✓         |
| analytics.export              | ✓            | ✓               |                |      |        | ✓              |           |
| audit.view                    | ✓            |                 |                |      |        |                |           |

(`(own)` = scoped to claims assigned to that user. `(assigned)` = limited to cases the doctor is on.)

### Permission storage and check

Roles are stored in `Role.permissions` as a JSON array of permission strings. The `RolesGuard` reads the user's roles via `UserRole`, unions the permissions, and checks against the required permission for each endpoint:

```ts
@Post('/preauth/:id/submit')
@RequirePermission('preauth.submit')
async submit(@Param('id') id: string) { ... }
```

Permissions are evaluated server-side. The frontend hides UI based on a per-session permission set fetched at login (`GET /me/permissions`).

---

## Part 4 — Audit events

Every auth and onboarding action writes to `AuditLog`. Event types:

```
USER_INVITED
USER_ACCEPTED_INVITE
USER_INVITE_RESENT
USER_INVITE_REVOKED
USER_LOGGED_IN
USER_LOGGED_OUT
USER_FAILED_LOGIN
USER_LOCKED
USER_UNLOCKED
USER_PASSWORD_RESET_REQUESTED
USER_PASSWORD_RESET_COMPLETED
USER_PASSWORD_CHANGED
USER_MFA_ENROLLED
USER_MFA_DISABLED
USER_MFA_RESET_BY_ADMIN
USER_DEACTIVATED
USER_REACTIVATED
USER_DELETED
ROLE_ASSIGNED
ROLE_REMOVED
SESSION_REVOKED

DOCTOR_SIGNATURE_REQUESTED
DOCTOR_SIGNATURE_TOKEN_USED
DOCTOR_SIGNED

TENANT_CREATED
TENANT_UPDATED
TENANT_LIFECYCLE_TRANSITION
TENANT_NHCX_CONFIGURED
TENANT_NHCX_CERT_ROTATED
TENANT_PMJAY_CONFIGURED
TENANT_BRANDING_UPDATED
TENANT_SUSPENDED
TENANT_REACTIVATED
TENANT_CHURNED
TENANT_IP_ALLOWLIST_UPDATED
```

Audit log is append-only via RLS. Queryable by tenant admin (own tenant) and platform admin (any tenant).

---

## Part 5 — Endpoints (auth + onboarding)

### Public (no auth)

```
POST /auth/login                            { email, password }
POST /auth/login/otp                        { mobile, otp }
POST /auth/login/otp/initiate               { mobile }
POST /auth/refresh                          { refreshToken }
POST /auth/mfa/verify                       { mfaToken, code }
POST /auth/password-reset/initiate          { email }
POST /auth/password-reset/verify            { token }
POST /auth/password-reset/complete          { token, newPassword }
GET  /auth/invite/:token                    (preview)
POST /auth/accept-invite                    { token, password, mfaSecret? }
GET  /auth/doctor-token/:token              (preview preauth)
POST /auth/doctor-otp/initiate              { token } (sends OTP)
POST /auth/doctor-otp                       { token, otp } (sign)
```

### Authenticated user

```
POST /auth/logout
POST /auth/mfa/enroll
POST /auth/mfa/disable
POST /auth/mfa/backup-codes/regenerate
GET  /auth/sessions                         (list active)
DELETE /auth/sessions/:id                   (revoke)
GET  /me                                    (profile)
PATCH /me                                   (update profile)
GET  /me/permissions                        (effective permissions for this session)
POST /me/password                           (change own password)
```

### Tenant admin

```
GET    /tenant/users
POST   /tenant/users                        (invite)
GET    /tenant/users/:id
PATCH  /tenant/users/:id
POST   /tenant/users/:id/resend-invite
POST   /tenant/users/:id/deactivate
POST   /tenant/users/:id/reactivate
POST   /tenant/users/:id/reset-mfa          (admin-initiated MFA reset)
POST   /tenant/users/:id/role               (assign role)
DELETE /tenant/users/:id/role/:roleId       (remove role)

GET    /tenant/security/ip-allowlist
PUT    /tenant/security/ip-allowlist
GET    /tenant/security/audit?from=...&to=...

GET    /tenant/branding
PUT    /tenant/branding

GET    /tenant/payers                        (enabled payers)
POST   /tenant/payers/:payerId/enable
POST   /tenant/payers/:payerId/disable

GET    /tenant/document-checklists
PUT    /tenant/document-checklists/:claimType
```

### Platform admin

```
POST /admin/tenants
GET  /admin/tenants
GET  /admin/tenants/:id
PATCH /admin/tenants/:id
POST /admin/tenants/:id/lifecycle           { newState, justification }
GET  /admin/tenants/:id/readiness
POST /admin/tenants/:id/users                (provision first admin)
POST /admin/tenants/:id/nhcx-cert            (multipart upload of cert)
POST /admin/tenants/:id/nhcx-cert/rotate
POST /admin/tenants/:id/pmjay-config
POST /admin/tenants/:id/pmjay-credentials    (encrypted)
GET  /admin/tenants/:id/audit?from=...&to=...
```

### Onboarding wizard

```
GET  /onboarding/setup-wizard
POST /onboarding/setup-wizard/step/:stepId/complete
POST /onboarding/setup-wizard/step/:stepId/skip
POST /onboarding/setup-wizard/finish
```

---

## Part 6 — Error codes specific to onboarding and auth

Add these to `reference/error-codes.md`:

```
AUTH_ACCOUNT_LOCKED                      423   Too many failed attempts
AUTH_INVITE_TOKEN_EXPIRED                401   Invite link expired
AUTH_INVITE_TOKEN_USED                   409   Invite already accepted
AUTH_INVITE_TOKEN_REVOKED                401   Invite was cancelled
AUTH_PASSWORD_TOO_WEAK                   422   Doesn't meet policy
AUTH_PASSWORD_REUSED                     422   Last 5 passwords cannot be reused
AUTH_PASSWORD_RESET_LIMIT_REACHED        429   Too many reset requests
AUTH_IP_NOT_ALLOWED                      403   IP not in tenant allowlist
AUTH_DEVICE_NOT_TRUSTED                  401   Step-up MFA required
AUTH_CONCURRENT_SESSION_LIMIT            403   Session cap reached; oldest session signed out
AUTH_SUSPICIOUS_LOGIN                    401   Step-up confirmation required
AUTH_HPR_VERIFICATION_FAILED             422   HPR registration not active
AUTH_MFA_ALREADY_ENROLLED                409   MFA already set up
AUTH_MFA_NOT_ENROLLED                    412   MFA enrollment required for this role
AUTH_BACKUP_CODE_INVALID                 401   Backup code wrong or already used

TENANT_LIFECYCLE_TRANSITION_INVALID      412   Cannot move tenant from <X> to <Y>
TENANT_NHCX_CERT_INVALID                 422   Cert file unreadable or wrong format
TENANT_NHCX_CERT_EXPIRED                 412   Cert is past expiry
TENANT_NHCX_CERT_NOT_UPLOADED            412   Cert is required for NHCX onboarding
TENANT_PMJAY_STATE_NOT_SUPPORTED         412   We don't yet support this state
TENANT_READINESS_CHECK_FAILED            412   Cannot move to LIVE — readiness items pending

ONBOARDING_STEP_INCOMPLETE               412   Setup wizard step required
ONBOARDING_OUT_OF_ORDER                  412   This step requires earlier steps to be complete
```

Modal copy for these follows the conventions in `docs/10-error-modal-system.md`.

---

## Part 7 — Frontend pages to build

```
apps/web/app/(auth)/
├── login/page.tsx
├── login/otp/page.tsx                     ← mobile OTP login
├── reset-password/initiate/page.tsx
├── reset-password/[token]/page.tsx
├── accept-invite/[token]/page.tsx         ← invite acceptance + first password + MFA enrollment
├── doctor-sign/[token]/page.tsx           ← doctor scoped flow
├── mfa-challenge/page.tsx                 ← TOTP entry during login
└── account-locked/page.tsx                ← post-lockout informational

apps/web/app/(dashboard)/onboarding/
└── setup-wizard/
    ├── page.tsx                            ← wizard shell
    ├── step-brand/page.tsx
    ├── step-nhcx/page.tsx
    ├── step-pmjay/page.tsx
    ├── step-payers/page.tsx
    ├── step-checklists/page.tsx
    ├── step-team/page.tsx
    └── step-test-case/page.tsx

apps/web/app/(dashboard)/admin/
├── users/page.tsx                          ← list, invite
├── users/[id]/page.tsx                     ← detail, role management
├── users/invite/page.tsx
├── security/page.tsx                       ← MFA defaults, IP allowlist
├── audit/page.tsx                          ← tenant-scoped audit log viewer
├── branding/page.tsx
└── tenant/page.tsx                         ← read-only tenant info, lifecycle status

apps/web/app/(dashboard)/profile/
├── page.tsx                                ← profile, contact info
├── security/page.tsx                       ← password, MFA, active sessions
└── activity/page.tsx                       ← own audit log
```

---

## Part 8 — What "onboarding & auth complete" looks like

Before we say this surface is shipped:

- [ ] All 8 default roles seeded; permission matrix enforced server-side.
- [ ] All endpoints in Part 5 implemented with OpenAPI docs.
- [ ] Setup wizard renders, completes, and unlocks PILOT lifecycle move.
- [ ] Readiness check runs and returns accurate `ready: true/false`.
- [ ] Invitation email + SMS deliver and accept flow works end-to-end.
- [ ] MFA enrollment + verify + backup codes + reset all work.
- [ ] Password policy enforced; haveibeenpwned check active.
- [ ] Lockout after 5 failed attempts in 15 min, auto-unlock after 15 min.
- [ ] IP allowlist enforced when configured.
- [ ] Concurrent session limit enforced; oldest session signed out.
- [ ] Doctor short-token flow tested end-to-end.
- [ ] HPR verification active for doctor account creation.
- [ ] Audit log captures all events listed in Part 4.
- [ ] Cross-tenant access test still passes.
- [ ] Lifecycle transitions audited and gated by role.
- [ ] Tenant readiness check enforces NHCX/PMJAY config before LIVE.
- [ ] Frontend wizard handles skip + resume correctly.
- [ ] All error codes from Part 6 have modal copy in `error-map.ts`.
