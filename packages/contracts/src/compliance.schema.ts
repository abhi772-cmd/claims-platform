// Slice BU — DPDP / IRDAI / RBI compliance dashboard payload.
//
// One read endpoint returns a tenant-scoped rollup that the operator
// (DPO, tenant admin, compliance reviewer) sees on a single screen.
// Each section is independently bounded so a tenant with millions of
// audit rows doesn't OOM the dashboard.

import { z } from 'zod';

import { BreachKindSchema, BreachSeveritySchema, BreachStatusSchema } from './breach.schema';
import { ConsentStatusSchema, ConsentTypeSchema } from './consent.schema';

// ---------- Retention rollup ----------

export const RetentionClassCountSchema = z.object({
  retentionClass: z.string(),
  total: z.number().int().nonnegative(),
  // Rows older than the class's floor that the BP sweeper would
  // remove on next run. The dashboard uses this to surface
  // "X past-floor rows pending sweep" — a triage signal that the
  // sweeper hasn't been run recently or that ops need to investigate
  // a misclassification.
  pastFloor: z.number().int().nonnegative(),
});
export type RetentionClassCount = z.infer<typeof RetentionClassCountSchema>;

// ---------- Erasure rollup ----------

export const ErasureSummaryRowSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['completed', 'rejected']),
  patientId: z.string().uuid().nullable(),
  blockingClaimsCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type ErasureSummaryRow = z.infer<typeof ErasureSummaryRowSchema>;

// ---------- Data access rollup ----------

export const DataAccessSummaryRowSchema = z.object({
  id: z.string().uuid(),
  occurredAt: z.string(),
  actorUserId: z.string().uuid().nullable(),
  actorType: z.string(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  purpose: z.string(),
  fieldNames: z.array(z.string()).nullable(),
  consentGrantId: z.string().uuid().nullable(),
  // Status of the bound consent at dashboard read time. Operators
  // see 'granted' as ✓, 'withdrawn' as ⚠ (read happened under a
  // grant that has since been withdrawn — informational, not
  // necessarily a breach), 'unbound' when consentGrantId is null.
  consentStatus: z.enum(['granted', 'withdrawn', 'expired', 'superseded', 'unbound']),
});
export type DataAccessSummaryRow = z.infer<typeof DataAccessSummaryRowSchema>;

// ---------- Breach rollup ----------

export const BreachSummaryRowSchema = z.object({
  id: z.string().uuid(),
  kind: BreachKindSchema,
  severity: BreachSeveritySchema,
  status: BreachStatusSchema,
  affectedDataPrincipals: z.number().int().nonnegative(),
  openedAt: z.string(),
  dpdpNotificationDueAt: z.string(),
  // True when status='detected' and dpdpNotificationDueAt < now.
  // Drives the red-banner "overdue" state on the dashboard.
  overdue: z.boolean(),
});
export type BreachSummaryRow = z.infer<typeof BreachSummaryRowSchema>;

export const BreachStatusCountsSchema = z.object({
  detected: z.number().int().nonnegative(),
  notified: z.number().int().nonnegative(),
  dismissed: z.number().int().nonnegative(),
  resolved: z.number().int().nonnegative(),
});
export type BreachStatusCounts = z.infer<typeof BreachStatusCountsSchema>;

// ---------- Consent rollup ----------

export const ConsentStatusCountsSchema = z.object({
  granted: z.number().int().nonnegative(),
  withdrawn: z.number().int().nonnegative(),
  expired: z.number().int().nonnegative(),
  superseded: z.number().int().nonnegative(),
});
export type ConsentStatusCounts = z.infer<typeof ConsentStatusCountsSchema>;

export const ConsentSummaryRowSchema = z.object({
  id: z.string().uuid(),
  patientId: z.string().uuid(),
  consentType: ConsentTypeSchema,
  status: ConsentStatusSchema,
  grantedAt: z.string(),
  withdrawnAt: z.string().nullable(),
});
export type ConsentSummaryRow = z.infer<typeof ConsentSummaryRowSchema>;

// ---------- Top-level payload ----------

export const ComplianceDashboardSchema = z.object({
  // ISO timestamp of when the snapshot was assembled. The dashboard
  // displays this so operators know whether they're looking at
  // stale data after their browser tab was idle.
  generatedAt: z.string(),

  retentionClasses: z.array(RetentionClassCountSchema),

  recentErasures: z.array(ErasureSummaryRowSchema),
  // Counts in the past 90 days — bounded so the query stays cheap.
  erasureCounts: z.object({
    completed: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
  }),

  recentDataAccess: z.array(DataAccessSummaryRowSchema),
  // Count of data_access_event rows in the past 24h that have NO
  // consentGrantId binding. A non-zero value means callers haven't
  // wired the BT consentGrantId thread for those reads — triage
  // signal for engineering, not necessarily a compliance breach.
  unboundAccessCountLast24h: z.number().int().nonnegative(),

  breachCounts: BreachStatusCountsSchema,
  openBreaches: z.array(BreachSummaryRowSchema),

  consentCounts: ConsentStatusCountsSchema,
  recentConsentChanges: z.array(ConsentSummaryRowSchema),
});
export type ComplianceDashboard = z.infer<typeof ComplianceDashboardSchema>;
