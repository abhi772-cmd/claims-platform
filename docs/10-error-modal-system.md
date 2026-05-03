# 10 — Error and Modal System

This doc explains the error code taxonomy, how errors flow from backend to UI, and how modals are wired. The exhaustive code → modal lookup is in `reference/error-codes.md`.

---

## Error code taxonomy

Codes are namespaced by domain:

```
AUTH_*         Authentication / authorization
TENANT_*       Multi-tenancy issues
PATIENT_*      Patient module errors
POLICY_*       Insurance policy errors
PMJAY_*        PMJAY-specific errors
PREAUTH_*      Pre-auth flow errors
CLAIM_*        Claim flow errors
ENHANCEMENT_*  Enhancement errors
DISCHARGE_*    Discharge errors
QUERY_*        Communication / query errors
SETTLEMENT_*   Payment / EOB / reconciliation errors
DOCUMENT_*     Document upload / scan errors
NHCX_*         NHCX gateway errors
ABDM_*         ABDM / ABHA errors
NOTIFICATION_* Email / SMS errors
CONSENT_*      Consent flow errors
RATE_*         Rate limiting
SYSTEM_*       Internal errors that escape the type system
```

Each code is `SCREAMING_SNAKE_CASE`, ≤40 characters.

---

## Error response shape (backend → frontend)

Every error response uses RFC 7807 Problem Details extended with our fields:

```json
{
  "type": "https://claims.digisparsh.in/errors/PREAUTH_QUERY_ALREADY_RESPONDED",
  "title": "Query response already submitted",
  "status": 409,
  "code": "PREAUTH_QUERY_ALREADY_RESPONDED",
  "detail": "This query was responded to at 2026-05-03T10:23:00Z by Priya Sharma.",
  "correlationId": "01HX7FMGZ5TR3W8JQK4YXNPVD2",
  "instance": "/api/v1/preauth/91d.../queries/abc/respond",
  "context": {
    "queryId": "abc",
    "respondedAt": "2026-05-03T10:23:00Z",
    "respondedById": "user-uuid"
  }
}
```

- `code` — what the frontend looks up
- `title` — short, displayable as modal title (the frontend may override with its own copy)
- `detail` — short explanation (frontend may also override)
- `correlationId` — for support/debugging
- `context` — structured data the frontend can use in the modal body

---

## Throwing errors in NestJS

We never `throw new Error(...)` from services. We throw domain errors:

```ts
// apps/api/src/common/errors/domain-error.ts
export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  context?: Record<string, unknown>;
}

export class PreauthAlreadySubmittedError extends DomainError {
  readonly code = 'PREAUTH_ALREADY_SUBMITTED';
  readonly httpStatus = 409;
  constructor(public preauthId: string, public submittedAt: Date) {
    super(`Preauth ${preauthId} already submitted at ${submittedAt.toISOString()}`);
    this.context = { preauthId, submittedAt };
  }
}
```

A global `DomainExceptionFilter` maps these to Problem Details responses:

```ts
@Catch(DomainError)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(error: DomainError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const req = ctx.getRequest();
    
    res.status(error.httpStatus).json({
      type: `https://claims.digisparsh.in/errors/${error.code}`,
      title: TITLES[error.code] || 'An error occurred',
      status: error.httpStatus,
      code: error.code,
      detail: error.message,
      correlationId: req.correlationId,
      instance: req.url,
      context: error.context,
    });
  }
}
```

Generic exceptions (anything not a `DomainError`) → `SYSTEM_UNEXPECTED_ERROR` with HTTP 500. Logged with full stack; user sees a generic "Something went wrong" modal.

---

## Frontend error handling

### Receive

A shared API client wraps fetch:

```ts
async function apiCall(path: string, init: RequestInit) {
  const res = await fetch(path, init);
  if (!res.ok) {
    const problem = await res.json() as ProblemDetails;
    throw new ApiError(problem);
  }
  return res.json();
}
```

### Decide modal

A central registry maps codes → modal configs:

```ts
// apps/web/components/modals/error-map.ts
import { ErrorModalConfig } from './ErrorModal';

export const ERROR_MAP: Record<string, ErrorModalConfig> = {
  PREAUTH_ALREADY_SUBMITTED: {
    severity: 'warning',
    title: 'Already submitted',
    body: (ctx) => `This pre-auth was already submitted at ${formatDate(ctx.submittedAt)}.`,
    primaryAction: { label: 'View pre-auth', handler: ({ ctx, router }) => router.push(`/preauth/${ctx.preauthId}`) },
    secondaryAction: { label: 'Close' },
    showDetails: false,
  },
  
  NHCX_GATEWAY_UNAVAILABLE: {
    severity: 'error',
    title: 'NHCX is currently unavailable',
    body: () => 'We tried reaching the NHCX gateway and it is not responding. Your submission has been queued and will retry automatically. You will be notified when it succeeds.',
    primaryAction: { label: 'OK' },
    showDetails: true,
  },
  
  PREAUTH_DOCUMENTS_INCOMPLETE: {
    severity: 'warning',
    title: 'Documents missing',
    body: (ctx) => `${ctx.missing.length} required document(s) are missing: ${ctx.missing.join(', ')}.`,
    primaryAction: { label: 'Upload documents', handler: ({ ctx, router }) => router.push(`/preauth/${ctx.preauthId}/documents`) },
    secondaryAction: { label: 'Cancel' },
    showDetails: false,
  },
  
  // ... full list lives in reference/error-codes.md
};
```

### Show

```tsx
const { showError } = useErrorModal();

try {
  await api.preauth.submit(payload);
} catch (e) {
  if (isApiError(e)) {
    showError(e.code, e.context);
  } else {
    showError('SYSTEM_UNEXPECTED_ERROR', { underlying: String(e) });
  }
}
```

`useErrorModal` is a hook over a Zustand store; one global modal renders.

---

## Inline validation vs modal

| Situation                                                      | Approach            |
|----------------------------------------------------------------|---------------------|
| Field is invalid as user types                                 | Inline below field  |
| Form has multiple invalid fields and user clicks Submit        | Inline + scroll to first error |
| Required field missing on submit                               | Inline              |
| Server-side validation rejected the payload                    | Inline + summary banner |
| Business rule prevents submission (e.g., already submitted)    | Modal               |
| External integration failed                                    | Modal               |
| Permission denied                                              | Modal               |
| Hard system error                                              | Modal               |

Rule of thumb: if the user can fix it by editing the form right now, inline. If the user needs to acknowledge or take a different action, modal.

---

## Notification vs modal vs toast

| Situation                                                  | Channel               |
|------------------------------------------------------------|------------------------|
| User just took an action and it succeeded ("Saved")        | Toast (auto-dismiss)   |
| Background event the user wasn't waiting for ("Approved!") | In-app notification + email/SMS, plus toast if app is open |
| User-initiated action failed                               | Modal                  |
| User-initiated action requires confirmation                | Modal                  |
| Server pushed an SLA breach warning                        | Notification + at-risk badge on the case |
| User logged in / out                                       | (no UI — logged silently) |
| Document upload progress                                   | Inline progress bar    |

---

## Loading states

Every mutating action shows a loading state:
- Disabled CTA with spinner inline
- Optimistic UI where safe (status updates locally, then confirmed)
- Skeleton for first paint of data-heavy pages
- "Working on it..." modal for long operations (>3s) where the user is actively waiting

Never show a spinner with no context. Always tell the user what's happening.

---

## Confirmation modals

Use sparingly. Confirmations are friction; reserve for irreversible operations:

- "Cancel this case?" — yes
- "Submit pre-auth to NHCX?" — yes (it's irreversible)
- "Save draft?" — no (just save)
- "Reassign claim?" — yes (changes ownership)

```tsx
<ConfirmModal
  open={open}
  severity="warning"
  title="Submit pre-auth to NHCX?"
  body="Once submitted, you cannot edit the bundle. Make sure all documents and amounts are final."
  confirmLabel="Submit"
  cancelLabel="Cancel"
  onConfirm={handleSubmit}
  onCancel={handleCancel}
/>
```

---

## Error codes — examples (full list in `reference/error-codes.md`)

A few illustrative ones to set the pattern:

```
AUTH_INVALID_CREDENTIALS                  401   Wrong email or password
AUTH_MFA_REQUIRED                         401   Account requires MFA
AUTH_SESSION_EXPIRED                      401   Session expired; please log in again
AUTH_TENANT_MISMATCH                      403   Token does not belong to this tenant
AUTH_INSUFFICIENT_PERMISSIONS             403   Your role does not allow this action

TENANT_NOT_FOUND                          404
TENANT_DISABLED                           403   Tenant has been disabled by platform admin
TENANT_NHCX_NOT_CONFIGURED                412   NHCX is not configured for this tenant

PATIENT_NOT_FOUND                         404
PATIENT_DUPLICATE_MRN                     409   A patient with this MRN already exists

POLICY_LOOKUP_FAILED                      502   We could not reach the payer to fetch your policy
POLICY_NOT_ACTIVE                         412   This policy is not currently active
POLICY_INSUFFICIENT_SUM_INSURED           412   Estimated cost exceeds available sum insured

PREAUTH_NOT_FOUND                         404
PREAUTH_ALREADY_SUBMITTED                 409
PREAUTH_DOCUMENTS_INCOMPLETE              412   Missing required documents
PREAUTH_DOCTOR_SIGNATURE_MISSING          412   Doctor has not signed the clinical justification
PREAUTH_QUERY_ALREADY_RESPONDED           409
PREAUTH_DRAFT_INVALID                     400   Draft has validation errors

NHCX_GATEWAY_UNAVAILABLE                  503   NHCX is not responding; submission queued
NHCX_AUTHENTICATION_FAILED                502   Could not get a session token from NHCX
NHCX_PAYER_REJECTED_BUNDLE                422   Payer rejected the FHIR Bundle (validation failed at payer side)
NHCX_CALLBACK_DECRYPT_FAILED              500   Internal: callback could not be decrypted
NHCX_CORRELATION_NOT_FOUND                404   Internal: correlation ID has no matching outbound

PMJAY_BENEFICIARY_NOT_FOUND               404   The PMJAY card / family ID could not be verified
PMJAY_PACKAGE_NOT_AVAILABLE_IN_STATE      412   This package is not active in your state
PMJAY_OPERATION_REQUIRES_PORTAL           200   (Not an error — informational, triggers assist mode)

DOCUMENT_FILE_TOO_LARGE                   413   File exceeds the maximum size of 25 MB
DOCUMENT_INVALID_TYPE                     415   Allowed types: PDF, JPG, PNG, ZIP
DOCUMENT_VIRUS_DETECTED                   422   File appears to contain malware; upload blocked
DOCUMENT_UPLOAD_FAILED                    500

EOB_PARSE_FAILED                          500   Could not parse the EOB; please enter manually
EOB_LOW_CONFIDENCE                        200   (Not an error — info; show the parsed values for review)

SETTLEMENT_AMOUNT_MISMATCH                412   Received amount does not match expected
SETTLEMENT_BANK_STATEMENT_PARSE_FAILED    500

CONSENT_NOT_GIVEN                         412   Patient has not given consent for NHCX processing
CONSENT_REVOKED                           412

RATE_TOO_MANY_REQUESTS                    429   Slow down

SYSTEM_UNEXPECTED_ERROR                   500   Generic — covered with apology + correlation ID for support
```

---

## Adding a new error

When you add a new error path:

1. Define the domain error class in the relevant module's `errors/` folder.
2. Add the code to the relevant section of `reference/error-codes.md` with:
   - HTTP status
   - One-line title
   - User-facing modal copy
   - Severity
   - Any context fields populated
3. Add the modal config to `apps/web/components/modals/error-map.ts`.
4. Add a unit test that triggers the error and verifies the response shape.
5. Add a Cypress / Playwright e2e test that triggers the error and verifies the modal appears.

CI fails if any throw of a `DomainError` does not have a matching entry in `error-map.ts`.

---

## Logging errors

When a domain error is thrown, the global filter logs:
- Severity (mapped from HTTP status: 4xx = warn, 5xx = error)
- Code, message, correlation ID
- Stack trace at debug level
- No PII (the redactor strips before write)

User-facing messages never include the raw error; users see the modal copy. Support can correlate via the correlation ID.
