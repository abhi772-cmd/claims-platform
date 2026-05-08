// Slice BQ — DPDP Act 2023 §11 erasure-on-request contracts. The
// patient's erasure request flows in via POST /erasure-requests
// with the patient id + a free-text descriptor of who filed it
// + optional reason. The service returns a row that's either
// 'completed' (PII redacted) or 'rejected' (active claims blocked
// the erasure under DPDP §13's legal-compliance carve-out).

import { z } from 'zod';

export const ErasureRequestStatusSchema = z.enum(['completed', 'rejected']);
export type ErasureRequestStatus = z.infer<typeof ErasureRequestStatusSchema>;

export const FileErasureRequestSchema = z.object({
  patientId: z.string().uuid(),
  // Free-text capture of who filed the request — name + ID-type
  // verification ops did off-platform (e.g. "ABHA 91-XXXX matched
  // by photo ID at front desk"). Bounded so the audit row stays
  // legible.
  requestedBy: z.string().min(1).max(500),
  reason: z.string().max(2000).optional(),
});
export type FileErasureRequest = z.infer<typeof FileErasureRequestSchema>;

export const ErasureRequestRowSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  patientId: z.string().uuid().nullable(),
  requestedBy: z.string(),
  reason: z.string().nullable(),
  status: ErasureRequestStatusSchema,
  // When status='rejected', list of claims still in non-terminal
  // status that blocked the erasure. Operator can come back when
  // these close (CLOSED / ABANDONED / WRITTEN_OFF).
  rejectionReason: z
    .object({
      blockingClaims: z.array(
        z.object({ id: z.string().uuid(), status: z.string() }),
      ),
    })
    .nullable(),
  // When status='completed', per-table redaction counts.
  affectedCounts: z
    .object({
      patient: z.number().int().nonnegative(),
      case: z.number().int().nonnegative(),
    })
    .nullable(),
  processedByUserId: z.string().uuid().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type ErasureRequestRow = z.infer<typeof ErasureRequestRowSchema>;
