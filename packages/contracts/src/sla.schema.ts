import { z } from 'zod';

// T2-15 — IRDAI SLA timers.
//
// IRDAI mandates two visible turnaround windows for cashless health
// insurance claims:
//   - PRE-AUTHORISATION: payer must respond within 1 hour of submission.
//   - DISCHARGE / FINAL CLAIM: payer must respond within 3 hours of
//     submission of the final claim package.
//
// SLA state is derived from the claim_event timeline at read time, not
// stored. No new tables, no schema migration. The pure computation
// lives in apps/api/src/modules/claim/sla-deadline.ts and is unit-tested
// against synthetic event streams.
//
// SLA phases:
//   "preauth"  — clock starts on first `preauth.submitted_internally`,
//                stops on first `preauth.{approved,rejected,
//                partially_approved,query_received}` after start.
//   "claim"    — clock starts on first `claim.submitted_internally`,
//                stops on first `claim.{approved,rejected,
//                partially_approved,query_received}` after start.
//
// SLA states:
//   "on_track"  — submitted, not decided, <50% of the window elapsed.
//   "at_risk"   — submitted, not decided, ≥50% of the window elapsed.
//   "breached"  — submitted, not decided, deadline already passed.
//   "met"       — decided before the deadline.
//   "missed"    — decided after the deadline (historical breach).
//
// Pills render green for met/on_track, amber for at_risk, red for
// breached/missed.

export const SlaPhaseSchema = z.enum(['preauth', 'claim']);
export type SlaPhase = z.infer<typeof SlaPhaseSchema>;

export const SlaStatusSchema = z.enum([
  'on_track',
  'at_risk',
  'breached',
  'met',
  'missed',
]);
export type SlaStatus = z.infer<typeof SlaStatusSchema>;

export const SlaStateSchema = z.object({
  phase: SlaPhaseSchema,
  // ISO datetime at which the clock started (submitted_internally event).
  startedAt: z.string().datetime(),
  // ISO datetime at which the SLA deadline lapses.
  deadlineAt: z.string().datetime(),
  // 60 or 180 in the current rules.
  windowMinutes: z.number().int().positive(),
  status: SlaStatusSchema,
  // Populated when status is "met" or "missed" — the moment the payer's
  // decision arrived.
  decidedAt: z.string().datetime().nullable(),
  // Milliseconds until deadline at the time the response was generated.
  // Negative when already past the deadline. Null when the SLA has
  // settled (met / missed).
  msUntilDeadline: z.number().int().nullable(),
});
export type SlaState = z.infer<typeof SlaStateSchema>;

export const ClaimSlaSchema = z.object({
  preauth: SlaStateSchema.nullable(),
  claim: SlaStateSchema.nullable(),
});
export type ClaimSla = z.infer<typeof ClaimSlaSchema>;

// Window constants are exported so the UI can fall back to a sensible
// default if the API ever omits them (it shouldn't, but defensive).
export const IRDAI_PREAUTH_WINDOW_MINUTES = 60;
export const IRDAI_CLAIM_WINDOW_MINUTES = 180;
