// Canonical permission strings. Keep these in lockstep with the seed in
// apps/api/prisma/seed.ts and the matrix in docs/14-onboarding-and-auth.md
// Part 3. New permissions land here first, then in the seed, then in the
// guard call sites.

export const Permissions = {
  // User admin
  USER_INVITE: 'user.invite',
  USER_UPDATE: 'user.update',
  USER_DEACTIVATE: 'user.deactivate',

  // Tenant admin
  TENANT_CREATE: 'tenant.create',
  TENANT_UPDATE: 'tenant.update',
  TENANT_LIFECYCLE_TRANSITION: 'tenant.lifecycle.transition',
  TENANT_SUSPEND: 'tenant.suspend',
  TENANT_CHURN: 'tenant.churn',
  TENANT_SECURITY_UPDATE: 'tenant.security.update',
  TENANT_ONBOARDING_UPDATE: 'tenant.onboarding.update',
  TENANT_COMMS_CONFIG_UPDATE: 'tenant.comms_config.update',

  // Master data
  PAYER_MASTER_VIEW: 'payer.master.view',
  PAYER_MASTER_EDIT: 'payer.master.edit',
  PACKAGE_MASTER_SYNC: 'package.master.sync',
  DOCUMENT_CHECKLIST_EDIT: 'document_checklist.edit',

  // Case
  CASE_CREATE: 'case.create',
  CASE_VIEW: 'case.view',
  CASE_ASSIGN: 'case.assign',

  // Preauth
  PREAUTH_DRAFT: 'preauth.draft',
  PREAUTH_SUBMIT: 'preauth.submit',
  // Slice BH — PMJAY preauth cancel via outbound task/submit.
  PREAUTH_CANCEL: 'preauth.cancel',
  PREAUTH_RESPOND_QUERY: 'preauth.respond_query',
  PREAUTH_APPROVE_INTERNAL: 'preauth.approve_internal',
  PREAUTH_SIGN_CLINICAL: 'preauth.sign_clinical',

  // Claim
  CLAIM_DRAFT: 'claim.draft',
  CLAIM_SUBMIT: 'claim.submit',
  // Slice BI — PMJAY CRC (Claim Re-Consideration) request.
  CLAIM_REPROCESS: 'claim.reprocess',
  // Slice BL — PMJAY claim re-submit on query (mirror of
  // PREAUTH_RESPOND_QUERY on the claim side).
  CLAIM_RESPOND_QUERY: 'claim.respond_query',

  // Settlement
  SETTLEMENT_UPLOAD_EOB: 'settlement.upload_eob',
  SETTLEMENT_CATEGORIZE_DEDUCT: 'settlement.categorize_deduct',
  SETTLEMENT_APPEAL: 'settlement.appeal',
  SETTLEMENT_WRITE_OFF: 'settlement.write_off',

  // Analytics
  ANALYTICS_VIEW: 'analytics.view',
  ANALYTICS_EXPORT: 'analytics.export',

  // Audit
  AUDIT_VIEW: 'audit.view',
  // Slice BQ — DPDP §11 erasure-on-request. Privileged operation
  // (PII redaction is irreversible) so we gate it on a dedicated
  // permission rather than reusing audit.view. Tenant-admin-only
  // by default; seed roles take it explicitly.
  ERASURE_PROCESS: 'erasure.process',

  // Slice BS — DPDP §8(6) breach incident management. Split into
  // view (compliance dashboards, security analysts) vs. manage
  // (DPO / tenant admin filing manual reports, marking notified /
  // dismissed). Both are sensitive — incidents reveal the actor's
  // identity and the categories of personal data implicated.
  BREACH_INCIDENT_VIEW: 'breach_incident.view',
  BREACH_INCIDENT_MANAGE: 'breach_incident.manage',

  // Slice BT — DPDP consent record management. View granted to
  // most operator roles (intake desks need to see if a patient
  // has consented to NHCX processing); manage limited to roles
  // capturing consent at admission + the DPO who handles
  // withdrawals. Withdrawals are irreversible at the record level
  // — a withdrawn grant cannot be re-granted; a new grant must
  // be filed.
  CONSENT_VIEW: 'consent.view',
  CONSENT_MANAGE: 'consent.manage',

  // Stage 5 — hospital-initiated communication/request outbound.
  // Send permission gates the new POST endpoint (any operator
  // role that can drive a case forward should be able to raise a
  // proactive payer query — variance question, clarification,
  // status nudge). View gates the timeline read. Both are
  // safe to grant broadly because the actual gateway traffic
  // is still rate-limited at the adapter layer.
  COMMUNICATION_SEND: 'communication.send',
  COMMUNICATION_VIEW: 'communication.view',
} as const;

export type Permission = (typeof Permissions)[keyof typeof Permissions];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(Permissions);
