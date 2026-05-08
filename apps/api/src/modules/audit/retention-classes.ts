// Slice BO — retention-class taxonomy for audit_log rows.
//
// Sprint 8 axis: strictest-of-three retention floor (DPDP Act 2023 +
// DPDP Rules 2025 + IRDAI 5y for claims + RBI 10y for any
// financial-transaction-touched record because DigiSparsh-lending is
// planned in v1). Every audit_log row carries a retention class so
// the BP sweeper, BQ erasure-on-request, and BU compliance dashboard
// can act on a single semantic field instead of re-deriving from
// the action string.
//
// The class is a stable semantic label; the actual year mapping is
// a separate concern (see RETENTION_FLOOR_DAYS below). Policy can
// change without breaking the column's value.

import { AuditEvents, type AuditEvent } from './audit.events';

// Six classes is enough to cover every event type we currently emit
// plus the audit categories we expect to add in BR (data_access_event)
// and BT (consent record). Add new classes only when an event genuinely
// doesn't fit any of these — most don't.
export const RetentionClasses = {
  // RBI 10y. Anything that touches a financial transaction: settlement,
  // payment, lending disbursement / repayment / write-off, EOB amounts,
  // approved / partially-approved / rejected with monetary impact.
  // Default fallback for unclassified rows because the conservative
  // choice is "keep longer".
  FINANCIAL: 'financial',

  // IRDAI 5y. Claim-aggregate state transitions, preauth decisions,
  // doctor signatures, document checksums, claim/preauth/communication
  // FHIR exchanges. Anything that documents the *clinical* + claims
  // process, distinct from the financial outcome.
  CLINICAL: 'clinical',

  // Strictest-of-three security retention. ~3y is a defensible window
  // for incident investigation under DPDP § "personal data principal
  // rights" reads + IRDAI cybersecurity guidelines. Covers password
  // resets, MFA enrolment / disable, account lock / unlock, role
  // grants, RBAC denials.
  SECURITY: 'security',

  // DPDP short-retention transit data. ~90 days. Login / logout
  // events, session revocations, and short-lived auth signals where
  // longer retention adds liability without adding investigative
  // value.
  SESSION: 'session',

  // Tenant + platform governance. Tenant lifecycle transitions,
  // NHCX config / cert rotations, branding updates, IP allowlist
  // changes, invitations, user lifecycle (deactivate / reactivate /
  // delete). ~8y to span both IRDAI 5y and the longer DPDP-derived
  // floor for operational governance.
  GOVERNANCE: 'governance',

  // DPDP consent records. Held until consent withdrawal +
  // statutory-floor years, per Rule 8. Bound to the data-subject's
  // consent record; covers the consent grant / update / withdrawal
  // events that BT ships.
  CONSENT: 'consent',
} as const;

export type RetentionClass = (typeof RetentionClasses)[keyof typeof RetentionClasses];

// The ordered list — useful for migration enums + UI dropdowns.
export const ALL_RETENTION_CLASSES: readonly RetentionClass[] = Object.values(RetentionClasses);

// Years (in days) for each class. Centralised so BP's sweeper and
// BU's dashboard read from one place. If the user later confirms
// DigiSparsh-lending is *not* in v1, the FINANCIAL floor collapses
// to IRDAI 5y; only this map needs to change.
export const RETENTION_FLOOR_DAYS: Readonly<Record<RetentionClass, number>> = {
  financial: 10 * 365, // RBI 10y
  clinical: 5 * 365, // IRDAI 5y
  security: 3 * 365, // DPDP/IRDAI security incident window
  session: 90, // DPDP transit
  governance: 8 * 365, // Strictest of IRDAI/DPDP for operational governance
  consent: 8 * 365, // Held until withdrawal + 8y; BT will refine
};

// Map every known AuditEvent to a retention class. Missing entries
// fall back to FINANCIAL (the conservative choice — keep longer).
// New audit events SHOULD be classified here at the same time the
// event is added to `audit.events.ts`. The fallback exists so an
// unclassified event doesn't break the write path.
const EVENT_TO_CLASS: Readonly<Record<AuditEvent, RetentionClass>> = {
  // Auth — login/logout/session is transit (DPDP 90d), failed-login
  // and lock/unlock are security-investigative (3y).
  [AuditEvents.USER_LOGGED_IN]: RetentionClasses.SESSION,
  [AuditEvents.USER_LOGGED_OUT]: RetentionClasses.SESSION,
  [AuditEvents.USER_FAILED_LOGIN]: RetentionClasses.SECURITY,
  [AuditEvents.USER_LOCKED]: RetentionClasses.SECURITY,
  [AuditEvents.USER_UNLOCKED]: RetentionClasses.SECURITY,
  [AuditEvents.SESSION_REVOKED]: RetentionClasses.SESSION,

  // Invitation — governance (account creation / removal flows).
  [AuditEvents.USER_INVITED]: RetentionClasses.GOVERNANCE,
  [AuditEvents.USER_ACCEPTED_INVITE]: RetentionClasses.GOVERNANCE,
  [AuditEvents.USER_INVITE_RESENT]: RetentionClasses.GOVERNANCE,
  [AuditEvents.USER_INVITE_REVOKED]: RetentionClasses.GOVERNANCE,

  // Password — security investigation window.
  [AuditEvents.USER_PASSWORD_RESET_REQUESTED]: RetentionClasses.SECURITY,
  [AuditEvents.USER_PASSWORD_RESET_COMPLETED]: RetentionClasses.SECURITY,
  [AuditEvents.USER_PASSWORD_CHANGED]: RetentionClasses.SECURITY,

  // MFA — security investigation window.
  [AuditEvents.USER_MFA_ENROLLED]: RetentionClasses.SECURITY,
  [AuditEvents.USER_MFA_DISABLED]: RetentionClasses.SECURITY,
  [AuditEvents.USER_MFA_RESET_BY_ADMIN]: RetentionClasses.SECURITY,

  // RBAC / lifecycle — governance.
  [AuditEvents.USER_DEACTIVATED]: RetentionClasses.GOVERNANCE,
  [AuditEvents.USER_REACTIVATED]: RetentionClasses.GOVERNANCE,
  [AuditEvents.USER_DELETED]: RetentionClasses.GOVERNANCE,
  [AuditEvents.ROLE_ASSIGNED]: RetentionClasses.GOVERNANCE,
  [AuditEvents.ROLE_REMOVED]: RetentionClasses.GOVERNANCE,

  // Doctor signatures — clinical evidence.
  [AuditEvents.DOCTOR_SIGNATURE_REQUESTED]: RetentionClasses.CLINICAL,
  [AuditEvents.DOCTOR_SIGNATURE_TOKEN_USED]: RetentionClasses.CLINICAL,
  [AuditEvents.DOCTOR_SIGNED]: RetentionClasses.CLINICAL,

  // Tenant lifecycle / config — governance.
  [AuditEvents.TENANT_CREATED]: RetentionClasses.GOVERNANCE,
  [AuditEvents.TENANT_UPDATED]: RetentionClasses.GOVERNANCE,
  [AuditEvents.TENANT_LIFECYCLE_TRANSITION]: RetentionClasses.GOVERNANCE,
  [AuditEvents.TENANT_NHCX_CONFIGURED]: RetentionClasses.GOVERNANCE,
  [AuditEvents.TENANT_NHCX_CERT_ROTATED]: RetentionClasses.GOVERNANCE,
  [AuditEvents.TENANT_PMJAY_CONFIGURED]: RetentionClasses.GOVERNANCE,
  [AuditEvents.TENANT_BRANDING_UPDATED]: RetentionClasses.GOVERNANCE,
  [AuditEvents.TENANT_SUSPENDED]: RetentionClasses.GOVERNANCE,
  [AuditEvents.TENANT_REACTIVATED]: RetentionClasses.GOVERNANCE,
  [AuditEvents.TENANT_CHURNED]: RetentionClasses.GOVERNANCE,
  [AuditEvents.TENANT_IP_ALLOWLIST_UPDATED]: RetentionClasses.GOVERNANCE,
};

// Classify an audit event for retention. Defaults to FINANCIAL when
// the action isn't in the static map — chosen as the conservative
// fallback ("keep longer") so an unmapped action never gets swept
// before we've classified it intentionally.
export function classifyAuditEvent(action: string): RetentionClass {
  // The static map is keyed by AuditEvent values; cast through string
  // and look it up. TS-side callers always pass a known event; the
  // string-typed signature exists for the migration backfill that
  // reads the column from raw SQL results.
  return EVENT_TO_CLASS[action as AuditEvent] ?? RetentionClasses.FINANCIAL;
}
