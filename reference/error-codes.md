# Error Codes — Master Reference

Every error code the platform can produce, mapped to HTTP status, modal severity, modal title, modal body copy, and recovery action. The `error-map.ts` on the frontend is generated from this file (or kept manually in sync — CI checks consistency).

Format per row:

```
CODE | HTTP | Severity | Title | Body | Primary Action | Secondary Action
```

---

## AUTH

| Code                                  | HTTP | Sev      | Title                                  | Body                                                                                                                | Primary             | Secondary  |
|---------------------------------------|------|----------|----------------------------------------|----------------------------------------------------------------------------------------------------------------------|---------------------|------------|
| AUTH_INVALID_CREDENTIALS              | 401  | error    | Sign in failed                          | The email or password you entered doesn't match our records.                                                       | Try again           | Reset password |
| AUTH_ACCOUNT_LOCKED                   | 423  | error    | Account temporarily locked              | Too many failed attempts. Try again in 15 minutes or contact your admin.                                            | OK                  | Contact admin |
| AUTH_MFA_REQUIRED                     | 401  | info     | Multi-factor authentication required    | Enter the 6-digit code from your authenticator app.                                                                | (inline form)       | Cancel     |
| AUTH_MFA_INVALID                      | 401  | error    | MFA code incorrect                      | The code you entered didn't match. Codes change every 30 seconds — try the latest one.                              | Retry               | Cancel     |
| AUTH_SESSION_EXPIRED                  | 401  | warning  | Your session has expired                | For your security, we logged you out after 15 minutes of inactivity. Please sign in again.                          | Sign in             |            |
| AUTH_TENANT_MISMATCH                  | 403  | critical | Wrong tenant                            | Your account doesn't have access to this organisation. Contact your platform admin if this is unexpected.           | Sign out            | Contact admin |
| AUTH_INSUFFICIENT_PERMISSIONS         | 403  | error    | You don't have permission for this      | Your role doesn't allow this action. Contact your billing manager or admin if you need access.                      | OK                  | Contact admin |
| AUTH_DOCTOR_TOKEN_EXPIRED             | 401  | warning  | This signature link has expired         | The link expires 10 minutes after it's sent. Ask your insurance desk to send a new one.                              | OK                  |            |
| AUTH_DOCTOR_TOKEN_INVALID             | 401  | error    | Invalid signature link                  | This link doesn't look right. Ask your insurance desk for a fresh one.                                              | OK                  |            |

## TENANT

| Code                                  | HTTP | Sev      | Title                                  | Body                                                                                                                | Primary             | Secondary  |
|---------------------------------------|------|----------|----------------------------------------|----------------------------------------------------------------------------------------------------------------------|---------------------|------------|
| TENANT_NOT_FOUND                      | 404  | error    | Organisation not found                  | This organisation doesn't exist.                                                                                    | OK                  |            |
| TENANT_DISABLED                       | 403  | critical | Organisation is disabled                | Your organisation has been temporarily disabled. Contact support.                                                    | Contact support     |            |
| TENANT_NHCX_NOT_CONFIGURED            | 412  | warning  | NHCX is not set up yet                  | Your hospital hasn't completed NHCX onboarding. Talk to your platform admin to enable cashless processing.          | View setup guide    | Cancel     |
| TENANT_PMJAY_NOT_CONFIGURED           | 412  | warning  | PMJAY is not set up yet                 | Your hospital isn't configured for PMJAY claims. Contact your admin.                                                 | View setup guide    | Cancel     |

## PATIENT

| Code                                  | HTTP | Sev      | Title                                  | Body                                                                                                                | Primary             | Secondary  |
|---------------------------------------|------|----------|----------------------------------------|----------------------------------------------------------------------------------------------------------------------|---------------------|------------|
| PATIENT_NOT_FOUND                     | 404  | warning  | Patient not found                       | We couldn't find a patient with this MRN. Check the number or create a new patient record.                          | Create new          | Try again  |
| PATIENT_DUPLICATE_MRN                 | 409  | warning  | Duplicate MRN                           | A patient with this MRN already exists.                                                                              | Open existing       | Cancel     |
| PATIENT_HIS_LOOKUP_FAILED             | 502  | error    | Couldn't reach the HIS                  | Your hospital's HIS isn't responding. You can enter patient details manually for now.                               | Enter manually      | Retry      |
| PATIENT_AGE_NOT_PERMITTED_FOR_PACKAGE | 412  | warning  | Patient age doesn't match this package  | This PMJAY package has age restrictions. Pick a different package or check the patient's date of birth.             | Change package      | Cancel     |

## POLICY

| Code                                  | HTTP | Sev      | Title                                  | Body                                                                                                                | Primary             | Secondary  |
|---------------------------------------|------|----------|----------------------------------------|----------------------------------------------------------------------------------------------------------------------|---------------------|------------|
| POLICY_LOOKUP_FAILED                  | 502  | error    | Couldn't fetch policy details            | We tried reaching the payer to fetch policy details and it didn't respond. You can enter details manually.          | Enter manually      | Retry      |
| POLICY_NOT_ACTIVE                     | 412  | warning  | Policy is not active                    | This policy is not currently active. Confirm with the patient and check the validity dates.                         | OK                  |            |
| POLICY_INSUFFICIENT_SUM_INSURED       | 412  | warning  | Sum insured may not cover this           | Estimated cost exceeds available sum insured (₹{available}). Discuss out-of-pocket payment with the patient.        | Continue anyway     | Cancel     |
| POLICY_DEPENDENT_NOT_LISTED           | 412  | warning  | Patient not listed as a dependent       | This patient isn't listed under the policy holder. Check the policy or contact the TPA.                            | OK                  |            |

## PMJAY

| Code                                       | HTTP | Sev      | Title                                  | Body                                                                                                                | Primary             | Secondary  |
|--------------------------------------------|------|----------|----------------------------------------|----------------------------------------------------------------------------------------------------------------------|---------------------|------------|
| PMJAY_BENEFICIARY_NOT_FOUND                | 404  | warning  | PMJAY beneficiary not found             | We couldn't verify this PMJAY card or family ID. Check the number on the patient's PMJAY card.                      | Try again           | Cancel     |
| PMJAY_BIS_API_UNAVAILABLE                  | 503  | error    | PMJAY verification system is down       | The PMJAY beneficiary verification system isn't responding. Try again in a few minutes.                              | Retry               | Verify in portal |
| PMJAY_PACKAGE_NOT_AVAILABLE_IN_STATE       | 412  | warning  | Package not available in this state     | This package isn't active in your state. Pick a different package.                                                   | Browse packages     | Cancel     |
| PMJAY_PACKAGE_DEPRECATED                   | 412  | warning  | Package has been deprecated             | This package was retired in HBP {version}. Use {replacement_code} instead.                                          | Use suggested       | Browse all |
| PMJAY_OPERATION_REQUIRES_PORTAL            | 200  | info     | This step happens on the PMJAY portal   | Open the PMJAY portal to complete this step. We've prepared the values for you.                                     | Open portal         | Cancel     |
| PMJAY_PORTAL_REFERENCE_INVALID             | 422  | warning  | Reference number doesn't look right     | Make sure you've copied the full reference from the PMJAY portal.                                                    | Try again           | Cancel     |
| BIOMETRIC_VERIFICATION_REQUIRED            | 412  | warning  | Biometric verification required          | PMJAY claims need an Aadhaar biometric / face / iris verification on the patient before this step. Capture biometric to continue. | Capture biometric  | Cancel     |
| BIOMETRIC_VERIFICATION_FAILED              | 422  | error    | Biometric verification didn't complete   | ABDM didn't accept the biometric capture. Try again, or switch to face or iris if your device supports it.            | Retry               | Cancel     |

## PREAUTH

| Code                                  | HTTP | Sev      | Title                                  | Body                                                                                                                | Primary             | Secondary  |
|---------------------------------------|------|----------|----------------------------------------|----------------------------------------------------------------------------------------------------------------------|---------------------|------------|
| PREAUTH_NOT_FOUND                     | 404  | error    | Pre-auth not found                       | This pre-authorization doesn't exist or you don't have access to it.                                                | Back to list        |            |
| PREAUTH_ALREADY_SUBMITTED             | 409  | warning  | Already submitted                        | This pre-auth was submitted at {time} by {user}.                                                                    | View submission     | Close      |
| PREAUTH_DRAFT_INVALID                 | 400  | warning  | Pre-auth draft is incomplete             | Required fields are missing. Review the form and complete the highlighted sections.                                 | Review form         |            |
| PREAUTH_DOCUMENTS_INCOMPLETE          | 412  | warning  | Documents missing                        | {count} required documents are missing: {list}. Upload these to submit.                                              | Upload documents    | Cancel     |
| PREAUTH_DOCTOR_SIGNATURE_MISSING      | 412  | warning  | Doctor signature missing                  | The treating doctor hasn't signed the clinical justification yet.                                                    | Send signature link | Skip       |
| PREAUTH_QUERY_ALREADY_RESPONDED       | 409  | warning  | Query already answered                    | This query was answered at {time} by {user}.                                                                        | View response       | Close      |
| PREAUTH_QUERY_DEADLINE_PASSED         | 412  | warning  | Query response window has closed         | The response window for this query has closed. The claim may be auto-rejected. Talk to the payer immediately.       | Contact payer       | OK         |
| PREAUTH_AMOUNT_EXCEEDS_SUM_INSURED    | 412  | warning  | Amount exceeds sum insured                | Pre-auth amount (₹{requested}) exceeds available sum insured (₹{available}).                                        | Reduce amount       | Continue   |
| PREAUTH_INVALID_DIAGNOSIS_PROCEDURE   | 422  | warning  | Diagnosis–procedure mismatch              | The diagnosis ({diagnosis}) doesn't typically map to the procedure ({procedure}). Verify before submitting.        | Edit form           | Continue anyway |

## CLAIM

| Code                                  | HTTP | Sev      | Title                                  | Body                                                                                                                | Primary             | Secondary  |
|---------------------------------------|------|----------|----------------------------------------|----------------------------------------------------------------------------------------------------------------------|---------------------|------------|
| CLAIM_NOT_FOUND                       | 404  | error    | Claim not found                          | This claim doesn't exist or you don't have access.                                                                  | Back to list        |            |
| CLAIM_ALREADY_SUBMITTED               | 409  | warning  | Claim already submitted                   | Submitted at {time} by {user}.                                                                                      | View submission     | Close      |
| CLAIM_PREAUTH_NOT_APPROVED            | 412  | error    | Pre-auth not approved                    | A claim cannot be submitted before its pre-authorization is approved.                                                | Open pre-auth       |            |
| CLAIM_DOCUMENTS_INCOMPLETE            | 412  | warning  | Required documents missing                | {count} required documents missing: {list}                                                                          | Upload documents    | Cancel     |
| CLAIM_AMOUNT_EXCEEDS_APPROVED         | 412  | warning  | Claim exceeds approved pre-auth           | Claim amount (₹{claimed}) exceeds approved pre-auth amount (₹{approved}). Submit an enhancement first.              | Open enhancement    | Continue anyway |
| CLAIM_REJECTION_NO_APPEAL_WINDOW      | 412  | warning  | Appeal window closed                     | The {days}-day window to appeal this rejection has closed.                                                           | OK                  |            |

## ENHANCEMENT

| Code                                       | HTTP | Sev      | Title                                  | Body                                                                                                                | Primary             | Secondary  |
|--------------------------------------------|------|----------|----------------------------------------|----------------------------------------------------------------------------------------------------------------------|---------------------|------------|
| ENHANCEMENT_PREAUTH_NOT_APPROVED           | 412  | error    | Pre-auth not approved                   | Enhancement requires an approved pre-auth.                                                                          | Open pre-auth       |            |
| ENHANCEMENT_PATIENT_DISCHARGED              | 412  | warning  | Patient already discharged              | Enhancements are for active stays. This patient was discharged on {date}.                                            | OK                  |            |
| ENHANCEMENT_AMOUNT_INVALID                 | 422  | warning  | Enhancement amount must be positive     | The enhancement amount must be greater than zero.                                                                    | Edit                |            |

## QUERY (communication)

| Code                                  | HTTP | Sev      | Title                                  | Body                                                                                                                | Primary             | Secondary  |
|---------------------------------------|------|----------|----------------------------------------|----------------------------------------------------------------------------------------------------------------------|---------------------|------------|
| QUERY_RESPONSE_BODY_TOO_LONG          | 422  | warning  | Response too long                       | Maximum 5000 characters per query response. You're at {count}.                                                      | Edit                |            |
| QUERY_RESPONSE_DOCUMENTS_REQUIRED     | 412  | warning  | Documents required                       | This payer requires supporting documents for query responses. Attach at least one before submitting.               | Attach              | Cancel     |
| COMMUNICATION_TEXT_REQUIRED           | 422  | warning  | Message text required                    | Enter the message you want to send to the payer before submitting.                                                  | Edit                |            |
| COMMUNICATION_REPLY_TARGET_NOT_FOUND  | 422  | warning  | Reply target missing                     | The message you're replying to no longer exists on this claim. Refresh and try again.                               | Refresh             | Cancel     |

## SETTLEMENT

| Code                                       | HTTP | Sev      | Title                                  | Body                                                                                                                | Primary             | Secondary  |
|--------------------------------------------|------|----------|----------------------------------------|----------------------------------------------------------------------------------------------------------------------|---------------------|------------|
| SETTLEMENT_AMOUNT_MISMATCH                 | 412  | warning  | Amounts don't match                     | Received amount (₹{received}) doesn't match expected (₹{expected}). Capture deduction reasons before continuing.    | Categorise          | Cancel     |
| SETTLEMENT_BANK_STATEMENT_PARSE_FAILED     | 500  | error    | Couldn't read the statement             | The bank statement file couldn't be parsed. Try a different format or enter manually.                                | Enter manually      | Try again  |
| SETTLEMENT_DUPLICATE_PAYMENT               | 409  | warning  | Possible duplicate payment              | This appears to match a payment already recorded for this claim.                                                     | Compare             | Cancel     |
| EOB_PARSE_FAILED                           | 500  | error    | Couldn't read the EOB                   | The EOB couldn't be automatically parsed. Enter the line items manually.                                            | Enter manually      |            |
| EOB_LOW_CONFIDENCE                         | 200  | info     | Review extracted values                 | We extracted line items from the EOB but our confidence is low. Please verify before saving.                         | Review              |            |

## DOCUMENT

| Code                                       | HTTP | Sev      | Title                                  | Body                                                                                                                | Primary             | Secondary  |
|--------------------------------------------|------|----------|----------------------------------------|----------------------------------------------------------------------------------------------------------------------|---------------------|------------|
| DOCUMENT_FILE_TOO_LARGE                    | 413  | warning  | File too large                          | Maximum 25 MB per file. This file is {size}.                                                                        | OK                  |            |
| DOCUMENT_INVALID_TYPE                      | 415  | warning  | Unsupported file type                   | Allowed types: PDF, JPG, PNG, ZIP. This file is {type}.                                                              | OK                  |            |
| DOCUMENT_VIRUS_DETECTED                    | 422  | critical | Possible malware detected               | This file appears to contain malware and was rejected. Use a different file or scan your device.                     | OK                  |            |
| DOCUMENT_UPLOAD_FAILED                     | 500  | error    | Upload failed                            | The upload couldn't complete. Check your internet and try again.                                                     | Retry               | Cancel     |
| DOCUMENT_CHECKLIST_MANDATORY_MISSING       | 412  | warning  | Required document missing               | The checklist requires {documentType}. Upload it to proceed.                                                         | Upload              | Cancel     |

## NHCX

| Code                                       | HTTP | Sev      | Title                                  | Body                                                                                                                | Primary             | Secondary  |
|--------------------------------------------|------|----------|----------------------------------------|----------------------------------------------------------------------------------------------------------------------|---------------------|------------|
| NHCX_GATEWAY_UNAVAILABLE                   | 503  | error    | NHCX is unavailable right now           | We're queuing your submission and will retry automatically. You'll be notified when it succeeds.                     | OK                  |            |
| NHCX_AUTHENTICATION_FAILED                 | 502  | error    | NHCX authentication failed              | We couldn't authenticate with NHCX. Our team has been notified. Please try again in a few minutes.                    | Retry               | Contact support |
| NHCX_PAYER_REJECTED_BUNDLE                 | 422  | error    | Payer rejected the submission           | The payer rejected the FHIR bundle: "{reason}". Review the bundle and resubmit.                                     | Review              | Contact support |
| NHCX_CALLBACK_DECRYPT_FAILED               | 500  | error    | Internal: callback couldn't be decrypted | (system-only — surfaced to ops, not user)                                                                          |                     |            |
| NHCX_CORRELATION_NOT_FOUND                 | 404  | error    | Internal: unknown correlation ID         | (system-only — surfaced to ops, not user)                                                                          |                     |            |
| NHCX_CERT_EXPIRED                          | 412  | critical | NHCX certificate has expired             | Your hospital's NHCX certificate has expired. Renew with NHA before continuing.                                     | View renewal guide  | Contact support |
| NHCX_HFR_FACILITY_NOT_REGISTERED            | 412  | critical | HFR facility not registered             | Your facility isn't registered in HFR for NHCX. Complete registration with NHA.                                     | View setup guide    |            |

## ABDM

| Code                                       | HTTP | Sev      | Title                                  | Body                                                                                                                | Primary             | Secondary  |
|--------------------------------------------|------|----------|----------------------------------------|----------------------------------------------------------------------------------------------------------------------|---------------------|------------|
| ABDM_ABHA_VERIFICATION_FAILED              | 422  | warning  | ABHA verification failed                | We couldn't verify this ABHA address. Check it with the patient.                                                     | Try again           | Skip       |
| ABDM_OTP_NOT_DELIVERED                     | 503  | error    | Couldn't send OTP                       | The patient's mobile didn't receive the OTP. Try again or use a different verification method.                       | Retry               | Use another method |
| ABDM_CONSENT_REVOKED                       | 412  | warning  | Patient revoked consent                 | The patient has revoked consent for ABDM data sharing. We can't proceed with linked records.                         | OK                  |            |

## NOTIFICATION

| Code                                       | HTTP | Sev      | Title                                  | Body                                                                                                                | Primary             | Secondary  |
|--------------------------------------------|------|----------|----------------------------------------|----------------------------------------------------------------------------------------------------------------------|---------------------|------------|
| NOTIFICATION_EMAIL_BOUNCED                 | 200  | info     | Email bounced                           | The email to {recipient} bounced. Check the address.                                                                | Update              |            |
| NOTIFICATION_SMS_FAILED                    | 200  | info     | SMS could not be delivered              | The SMS to {recipient} couldn't be delivered. Try email or update the number.                                       | Update              |            |

## CONSENT

| Code                                       | HTTP | Sev      | Title                                  | Body                                                                                                                | Primary             | Secondary  |
|--------------------------------------------|------|----------|----------------------------------------|----------------------------------------------------------------------------------------------------------------------|---------------------|------------|
| CONSENT_NOT_GIVEN                          | 412  | warning  | Patient consent required                | We need the patient's consent to proceed. Capture consent now or skip.                                              | Capture consent     | Cancel     |
| CONSENT_REVOKED                            | 412  | warning  | Consent revoked                         | The patient has revoked consent. We cannot proceed with the requested operation.                                     | OK                  |            |
| CONSENT_EXPIRED                            | 412  | warning  | Consent expired                         | The previous consent has expired. Capture fresh consent to continue.                                                 | Capture consent     | Cancel     |

## RATE LIMITING

| Code                                       | HTTP | Sev      | Title                                  | Body                                                                                                                | Primary             | Secondary  |
|--------------------------------------------|------|----------|----------------------------------------|----------------------------------------------------------------------------------------------------------------------|---------------------|------------|
| RATE_TOO_MANY_REQUESTS                     | 429  | warning  | Slow down                                | You've made too many requests in a short time. Wait a moment and try again.                                          | OK                  |            |

## SYSTEM

| Code                                       | HTTP | Sev      | Title                                  | Body                                                                                                                | Primary             | Secondary  |
|--------------------------------------------|------|----------|----------------------------------------|----------------------------------------------------------------------------------------------------------------------|---------------------|------------|
| SYSTEM_UNEXPECTED_ERROR                    | 500  | error    | Something went wrong                     | An unexpected error happened on our side. Reference: {correlationId}. Our team has been notified.                   | OK                  | Contact support |
| SYSTEM_MAINTENANCE                         | 503  | info     | Brief maintenance                        | We're doing scheduled maintenance. Back shortly.                                                                    | OK                  |            |
| SYSTEM_DEGRADED                            | 503  | warning  | Some features are slow right now         | A non-critical service is degraded. Most things still work normally.                                                 | OK                  |            |

---

## Conventions

- {placeholder} = filled in by frontend from `context` field of the error response.
- "(system-only)" — these errors are logged for ops but should never surface a modal to a normal user; they get a generic SYSTEM_UNEXPECTED_ERROR modal instead.
- Severity rules:
  - **info** — informational, blue icon, single OK CTA
  - **success** — green icon, used for confirmations (rarely as an error)
  - **warning** — amber icon, user can recover
  - **error** — red icon, user must take action
  - **critical** — dark red icon, blocks operation, often requires admin

---

## Adding new codes

When you add a new error path:
1. Add a row to the relevant section above.
2. Define the domain error class in `apps/api/src/modules/<module>/errors/`.
3. Add the modal config to `apps/web/components/modals/error-map.ts` (or update the generator script).
4. Add a unit test for the throw and a frontend test for the modal.
5. Open a PR — CI checks consistency.
