// Canonical audit event types — see docs/14 Part 4 for the full list.
// Events grow per-sprint as features land. Treat additions as breaking
// only if external dashboards consume the action string.

export const AuditEvents = {
  // Auth (Slice A)
  USER_LOGGED_IN: 'USER_LOGGED_IN',
  USER_LOGGED_OUT: 'USER_LOGGED_OUT',
  USER_FAILED_LOGIN: 'USER_FAILED_LOGIN',
  USER_LOCKED: 'USER_LOCKED',
  USER_UNLOCKED: 'USER_UNLOCKED',
  SESSION_REVOKED: 'SESSION_REVOKED',

  // Invitation (lands in Slice B)
  USER_INVITED: 'USER_INVITED',
  USER_ACCEPTED_INVITE: 'USER_ACCEPTED_INVITE',
  USER_INVITE_RESENT: 'USER_INVITE_RESENT',
  USER_INVITE_REVOKED: 'USER_INVITE_REVOKED',

  // Password (Slice C)
  USER_PASSWORD_RESET_REQUESTED: 'USER_PASSWORD_RESET_REQUESTED',
  USER_PASSWORD_RESET_COMPLETED: 'USER_PASSWORD_RESET_COMPLETED',
  USER_PASSWORD_CHANGED: 'USER_PASSWORD_CHANGED',

  // MFA (Slice D)
  USER_MFA_ENROLLED: 'USER_MFA_ENROLLED',
  USER_MFA_DISABLED: 'USER_MFA_DISABLED',
  USER_MFA_RESET_BY_ADMIN: 'USER_MFA_RESET_BY_ADMIN',

  // Lifecycle / RBAC
  USER_DEACTIVATED: 'USER_DEACTIVATED',
  USER_REACTIVATED: 'USER_REACTIVATED',
  USER_DELETED: 'USER_DELETED',
  ROLE_ASSIGNED: 'ROLE_ASSIGNED',
  ROLE_REMOVED: 'ROLE_REMOVED',

  // Doctor (Slice F)
  DOCTOR_SIGNATURE_REQUESTED: 'DOCTOR_SIGNATURE_REQUESTED',
  DOCTOR_SIGNATURE_TOKEN_USED: 'DOCTOR_SIGNATURE_TOKEN_USED',
  DOCTOR_SIGNED: 'DOCTOR_SIGNED',

  // Tenant lifecycle (Slice G)
  TENANT_CREATED: 'TENANT_CREATED',
  TENANT_UPDATED: 'TENANT_UPDATED',
  TENANT_LIFECYCLE_TRANSITION: 'TENANT_LIFECYCLE_TRANSITION',
  TENANT_NHCX_CONFIGURED: 'TENANT_NHCX_CONFIGURED',
  TENANT_NHCX_CERT_ROTATED: 'TENANT_NHCX_CERT_ROTATED',
  TENANT_PMJAY_CONFIGURED: 'TENANT_PMJAY_CONFIGURED',
  TENANT_BRANDING_UPDATED: 'TENANT_BRANDING_UPDATED',
  TENANT_SUSPENDED: 'TENANT_SUSPENDED',
  TENANT_REACTIVATED: 'TENANT_REACTIVATED',
  TENANT_CHURNED: 'TENANT_CHURNED',
  TENANT_IP_ALLOWLIST_UPDATED: 'TENANT_IP_ALLOWLIST_UPDATED',

  // Slice BP — self-audit row written at the end of every retention
  // sweep. Captures per-class delete counts + duration so ops /
  // compliance auditors can see when data was last erased.
  AUDIT_RETENTION_SWEEP_COMPLETED: 'AUDIT_RETENTION_SWEEP_COMPLETED',

  // Slice BQ — DPDP §11 erasure-on-request lifecycle. Two terminal
  // outcomes: completed (PII redacted) or rejected (active claims
  // blocked). v1 has no intermediate verified/pending state.
  ERASURE_REQUEST_PROCESSED: 'ERASURE_REQUEST_PROCESSED',
  ERASURE_REQUEST_REJECTED: 'ERASURE_REQUEST_REJECTED',

  // Slice CG — DPDP §6 hard-enforcement flag flipped per tenant.
  // Operators turn this on once the BU dashboard's "unbound
  // access in 24h" count is zero for the tenant. Audit row
  // captures before/after so the rollout history is reconstructable.
  TENANT_REQUIRE_CONSENT_UPDATED: 'TENANT_REQUIRE_CONSENT_UPDATED',

  // Slice BS — DPDP §8(6) breach incident lifecycle. Detection (auto)
  // and manual filing both land BREACH_INCIDENT_OPENED; transition
  // events flip status to notified / dismissed / resolved. The detector
  // also writes a self-audit row at sweep end so ops can see when it
  // last ran.
  BREACH_INCIDENT_OPENED: 'BREACH_INCIDENT_OPENED',
  BREACH_INCIDENT_NOTIFIED: 'BREACH_INCIDENT_NOTIFIED',
  BREACH_INCIDENT_DISMISSED: 'BREACH_INCIDENT_DISMISSED',
  BREACH_DETECTOR_SCAN_COMPLETED: 'BREACH_DETECTOR_SCAN_COMPLETED',

  // Slice BT — DPDP consent record lifecycle. Grant + withdraw are
  // operator-driven; expiry is currently triggered by the read-time
  // `requireConsent` check (no sweeper yet — a future slice can add
  // one when v1 demand justifies it).
  CONSENT_GRANTED: 'CONSENT_GRANTED',
  CONSENT_WITHDRAWN: 'CONSENT_WITHDRAWN',

  // Slice CM — DPDP consent OTP capture lifecycle. The OTP artifact
  // is recorded independently of the eventual consent_record so that
  // initiate / verify-fail / verify-success each leave a row even
  // when the patient never completes verification.
  CONSENT_OTP_INITIATED: 'CONSENT_OTP_INITIATED',
  CONSENT_OTP_VERIFIED: 'CONSENT_OTP_VERIFIED',
  CONSENT_OTP_VERIFY_FAILED: 'CONSENT_OTP_VERIFY_FAILED',
} as const;

export type AuditEvent = (typeof AuditEvents)[keyof typeof AuditEvents];
