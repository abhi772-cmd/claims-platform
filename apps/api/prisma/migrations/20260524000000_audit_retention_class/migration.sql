-- Slice BO — audit_log retention classification.
--
-- Sprint 8 axis: strictest-of-three retention floor (DPDP Act 2023 +
-- DPDP Rules 2025 + IRDAI 5y for claims + RBI 10y because
-- DigiSparsh-lending is planned in v1). Adding a stable semantic
-- label per row drives the BP sweeper, BQ erasure-on-request, and
-- BU compliance dashboard from one column instead of re-deriving
-- from the action string.
--
-- Default value 'financial' is deliberate: it's the conservative
-- choice (longest retention, RBI 10y) so an unmapped action never
-- gets swept too early. The TS classifier in
-- `apps/api/src/modules/audit/retention-classes.ts` is the source
-- of truth; this migration mirrors it for the backfill.

-- 1. Add the column with the conservative default.
ALTER TABLE "audit_log"
  ADD COLUMN "retentionClass" TEXT NOT NULL DEFAULT 'financial';

-- 2. Backfill existing rows by mapping action → class. Mirrors
-- EVENT_TO_CLASS in retention-classes.ts. Anything not in the map
-- keeps the 'financial' default — same fallback behaviour as the
-- TS classifier.

-- Session (DPDP transit, 90d).
UPDATE "audit_log" SET "retentionClass" = 'session' WHERE "action" IN (
  'USER_LOGGED_IN',
  'USER_LOGGED_OUT',
  'SESSION_REVOKED'
);

-- Security (DPDP/IRDAI security incident window, 3y).
UPDATE "audit_log" SET "retentionClass" = 'security' WHERE "action" IN (
  'USER_FAILED_LOGIN',
  'USER_LOCKED',
  'USER_UNLOCKED',
  'USER_PASSWORD_RESET_REQUESTED',
  'USER_PASSWORD_RESET_COMPLETED',
  'USER_PASSWORD_CHANGED',
  'USER_MFA_ENROLLED',
  'USER_MFA_DISABLED',
  'USER_MFA_RESET_BY_ADMIN'
);

-- Clinical (IRDAI 5y).
UPDATE "audit_log" SET "retentionClass" = 'clinical' WHERE "action" IN (
  'DOCTOR_SIGNATURE_REQUESTED',
  'DOCTOR_SIGNATURE_TOKEN_USED',
  'DOCTOR_SIGNED'
);

-- Governance (operational governance, 8y).
UPDATE "audit_log" SET "retentionClass" = 'governance' WHERE "action" IN (
  'USER_INVITED',
  'USER_ACCEPTED_INVITE',
  'USER_INVITE_RESENT',
  'USER_INVITE_REVOKED',
  'USER_DEACTIVATED',
  'USER_REACTIVATED',
  'USER_DELETED',
  'ROLE_ASSIGNED',
  'ROLE_REMOVED',
  'TENANT_CREATED',
  'TENANT_UPDATED',
  'TENANT_LIFECYCLE_TRANSITION',
  'TENANT_NHCX_CONFIGURED',
  'TENANT_NHCX_CERT_ROTATED',
  'TENANT_PMJAY_CONFIGURED',
  'TENANT_BRANDING_UPDATED',
  'TENANT_SUSPENDED',
  'TENANT_REACTIVATED',
  'TENANT_CHURNED',
  'TENANT_IP_ALLOWLIST_UPDATED'
);

-- 3. Index the (retentionClass, occurredAt) pair so BP's sweeper can
-- run an indexed lookup of "rows past their floor" without a full
-- audit_log scan. Tenant-scoped queries already use the existing
-- (tenantId, occurredAt) index; the sweeper is platform-scoped.
CREATE INDEX "audit_log_retentionClass_occurredAt_idx"
  ON "audit_log"("retentionClass", "occurredAt");
