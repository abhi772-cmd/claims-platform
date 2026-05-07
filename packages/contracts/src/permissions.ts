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
} as const;

export type Permission = (typeof Permissions)[keyof typeof Permissions];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(Permissions);
