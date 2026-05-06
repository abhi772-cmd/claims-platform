import { z } from 'zod';

// Audit-log viewer (Slice V). The list endpoint supports filtering by
// time range, action, resource, and actor. The CSV export endpoint
// shares the same filter shape.

export const AuditLogEntrySchema = z.object({
  id: z.string().uuid(),
  occurredAt: z.string().datetime(),
  actorUserId: z.string().uuid().nullable(),
  actorType: z.enum(['user', 'system', 'scheduled']),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  // before/after are arbitrary JSON snapshots curated by callers — the
  // service redacts known-PII keys before persisting, so the wire shape
  // is always-safe to render.
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  correlationId: z.string().nullable(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

// Common filters shared by list + export. All optional. Server clamps
// limit to [1, 200]; CSV export ignores limit + offset and streams the
// full filtered result.
export const AuditLogFilterSchema = z.object({
  // Inclusive lower bound on occurredAt.
  from: z.string().datetime().optional(),
  // Exclusive upper bound on occurredAt.
  to: z.string().datetime().optional(),
  action: z.string().min(1).max(120).optional(),
  resourceType: z.string().min(1).max(64).optional(),
  resourceId: z.string().min(1).max(120).optional(),
  actorUserId: z.string().uuid().optional(),
  correlationId: z.string().min(1).max(120).optional(),
});
export type AuditLogFilter = z.infer<typeof AuditLogFilterSchema>;

export const AuditLogListResponseSchema = z.object({
  entries: z.array(AuditLogEntrySchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type AuditLogListResponse = z.infer<typeof AuditLogListResponseSchema>;
