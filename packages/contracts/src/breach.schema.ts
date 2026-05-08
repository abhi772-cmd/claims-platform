// Slice BS — DPDP §8(6) breach incident contracts.
//
// Two ways an incident lands:
//   1. Auto-detected from data_access_event by BreachDetectorService
//      (BURST_DECRYPT — single actor decrypts > N patients in M
//      minutes).
//   2. Operator filed via POST /breach-incidents with kind='MANUAL_REPORT'
//      and operator-supplied severity + description.
//
// Lifecycle: detected → notified | dismissed | resolved.
// dpdpNotificationDueAt is openedAt + 72h; the BU dashboard surfaces
// rows where the deadline has passed and dpdpNotificationSentAt is
// still null.

import { z } from 'zod';

export const BreachKindSchema = z.enum(['BURST_DECRYPT', 'MANUAL_REPORT']);
export type BreachKind = z.infer<typeof BreachKindSchema>;

export const BreachSeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type BreachSeverity = z.infer<typeof BreachSeveritySchema>;

export const BreachStatusSchema = z.enum([
  'detected',
  'notified',
  'dismissed',
  'resolved',
]);
export type BreachStatus = z.infer<typeof BreachStatusSchema>;

// File a manual breach report. Auto-detected rows take a different
// path (the detector calls the service directly, no controller).
export const FileBreachIncidentSchema = z.object({
  severity: BreachSeveritySchema,
  description: z.string().min(10).max(4000),
  // Operator's free-text labels — 'aadhaar', 'mobile', 'patient',
  // 'session_token', etc. Bounded so the JSON stays sane.
  dataCategories: z.array(z.string().min(1).max(64)).min(1).max(20),
  // Operator's count — distinct data principals affected. Required
  // because it drives the §8(6) "approximate number" line.
  affectedDataPrincipals: z.number().int().nonnegative(),
});
export type FileBreachIncident = z.infer<typeof FileBreachIncidentSchema>;

export const NotifyBreachIncidentSchema = z.object({
  // Operator confirms the rendered template should be the artifact
  // we snapshot. Future iterations may accept overrides; v1 is
  // template-as-rendered.
  acknowledged: z.literal(true),
});
export type NotifyBreachIncident = z.infer<typeof NotifyBreachIncidentSchema>;

export const DismissBreachIncidentSchema = z.object({
  // Required on dismissal — DPDP audit trail needs the reason a
  // potential breach was deemed not-reportable.
  reason: z.string().min(10).max(2000),
});
export type DismissBreachIncident = z.infer<typeof DismissBreachIncidentSchema>;

// Optional filters for GET /breach-incidents. Bounded so a stray
// filter doesn't cripple the query planner.
export const BreachIncidentFilterSchema = z.object({
  status: BreachStatusSchema.optional(),
  kind: BreachKindSchema.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type BreachIncidentFilter = z.infer<typeof BreachIncidentFilterSchema>;

// Rendered DPDP §8(6) notification template. Subject + body are
// what an operator would copy into the Data Protection Board's
// portal; `fields` is the structured form for downstream tooling
// (e.g. an automated submission once the DPB API exists).
export const DpdpNotificationPayloadSchema = z.object({
  subject: z.string(),
  body: z.string(),
  fields: z.object({
    incidentId: z.string().uuid(),
    tenantSlug: z.string(),
    incidentKind: BreachKindSchema,
    severity: BreachSeveritySchema,
    openedAt: z.string(),
    dueAt: z.string(),
    description: z.string(),
    affectedDataPrincipals: z.number().int().nonnegative(),
    dataCategories: z.array(z.string()),
    likelyConsequences: z.string(),
    mitigationMeasures: z.string(),
    grievanceOfficerContact: z.string(),
  }),
});
export type DpdpNotificationPayload = z.infer<typeof DpdpNotificationPayloadSchema>;

export const BreachIncidentRowSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  kind: BreachKindSchema,
  severity: BreachSeveritySchema,
  status: BreachStatusSchema,
  actorUserId: z.string().uuid().nullable(),
  affectedDataPrincipals: z.number().int().nonnegative(),
  dataCategories: z.array(z.string()),
  description: z.string(),
  evidenceEventIds: z.array(z.string().uuid()),
  windowStart: z.string().nullable(),
  windowEnd: z.string().nullable(),
  openedAt: z.string(),
  dpdpNotificationDueAt: z.string(),
  dpdpNotificationSentAt: z.string().nullable(),
  dpdpNotificationPayload: DpdpNotificationPayloadSchema.nullable(),
  dismissalReason: z.string().nullable(),
  processedByUserId: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BreachIncidentRow = z.infer<typeof BreachIncidentRowSchema>;

export const BreachIncidentListResponseSchema = z.object({
  rows: z.array(BreachIncidentRowSchema),
  total: z.number().int().nonnegative(),
});
export type BreachIncidentListResponse = z.infer<typeof BreachIncidentListResponseSchema>;

export const BreachScanResultSchema = z.object({
  // Total incidents created on this scan invocation (across all
  // tenants when called platform-wide, or just this tenant when
  // called from the controller).
  incidentsCreated: z.number().int().nonnegative(),
  // Per-kind breakdown; empty kinds elided.
  byKind: z.record(BreachKindSchema, z.number().int().nonnegative()),
  // Wall-clock duration in milliseconds.
  durationMs: z.number().int().nonnegative(),
  // ISO of when the scan finished.
  completedAt: z.string(),
});
export type BreachScanResult = z.infer<typeof BreachScanResultSchema>;
