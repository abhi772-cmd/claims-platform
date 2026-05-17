import { z } from 'zod';

import {
  ClaimEventTypeSchema,
  ClaimRailSchema,
  ClaimSchema,
  ClaimStatusSchema,
} from './claim.schema';
import {
  ConsentEvidenceSchema,
  ConsentTypeSchema,
  LawfulBasisSchema,
} from './consent.schema';
import { ClaimSlaSchema } from './sla.schema';

// Encrypted PII payload attached to a new case. patientName + hospitalMrn
// remain on Case for fast list-view rendering; everything else goes into
// the Patient row encrypted with the tenant DEK.
export const PatientPiiInputSchema = z.object({
  // Aadhaar must be 12 digits; we let the server normalise (strip
  // spaces) before validation.
  aadhaar: z.string().regex(/^[0-9]{12}$/).optional(),
  // ABHA ID can be the 14-digit health id or the human-readable form
  // like "12-3456-7890-1234". Accept either by stripping non-digits.
  abhaId: z.string().min(1).max(64).optional(),
  policyNumber: z.string().min(1).max(120).optional(),
  // E.164-ish; we only require leading + and 8–15 digits.
  mobile: z.string().regex(/^\+?[0-9]{8,15}$/).optional(),
  email: z.string().email().max(254).optional(),
  dateOfBirth: z.string().date().optional(),
  gender: z.enum(['male', 'female', 'other', 'prefer_not_to_say']).optional(),
});
export type PatientPiiInput = z.infer<typeof PatientPiiInputSchema>;

// Slice CF — consent block captured at intake time. Optional for
// back-compat with Sprint 2-9 callers; the Sprint 10 hard-enforcement
// rollout will require it on tenants whose `requireConsent` flag is
// flipped. Lawful basis defaults to 'consent' which is the right
// answer for every operator-driven intake; carve-outs (legal_obligation
// for emergency walk-ins, public_interest for state schemes) are
// explicit overrides.
export const IntakeConsentSchema = z.object({
  consentType: ConsentTypeSchema,
  // At least one each — empty arrays defeat the point of consent
  // (the dashboard surfaces "no scope" rows for review). Ranges
  // mirror BT's GrantConsentSchema.
  dataCategories: z.array(z.string().min(1).max(64)).min(1).max(20),
  purposes: z.array(z.string().min(1).max(64)).min(1).max(20),
  lawfulBasis: LawfulBasisSchema.default('consent'),
  source: z.string().min(1).max(500),
  evidence: ConsentEvidenceSchema,
  expiresAt: z.string().datetime().optional(),
});
export type IntakeConsent = z.infer<typeof IntakeConsentSchema>;

// POST /cases — admin / insurance desk creates a case + the first claim
// in one shot. patientName + hospitalMrn live on Case (plaintext display
// fields). All sensitive identifiers go into the optional `patient`
// block which is encrypted at rest.
export const CreateCaseRequestSchema = z.object({
  patientName: z.string().min(1).max(200),
  hospitalMrn: z.string().min(1).max(64),
  admissionDate: z.string().date(),
  admissionType: z.enum(['planned', 'emergency', 'day_care']),
  primaryRail: ClaimRailSchema,
  treatingDoctorId: z.string().uuid().optional(),
  // Optional in V1 so existing tests + dev flows that didn't pass PII
  // continue to work. PMJAY submit will fail later if Aadhaar is
  // missing — that gate lives in the rail-specific submit layer, not
  // here.
  patient: PatientPiiInputSchema.optional(),
  // Slice CF — capture consent at intake. When present, the case +
  // patient + consent commit atomically inside one tenant tx.
  // Server rejects with 422 when consent is supplied but
  // patient is not (you can't bind a consent to a non-existent
  // patient row).
  consent: IntakeConsentSchema.optional(),
  // T2-14 — room rent sub-limit pre-warn. All three optional;
  // when both rate + limit are present the UI computes the
  // per-day liability and the projected out-of-pocket. Paise.
  // Capped at ₹100k/day (10_000_000 paise) to catch data-entry
  // typos that would otherwise show six-figure liabilities.
  roomDailyRate: z.number().int().nonnegative().max(10_000_000).optional(),
  policyRoomRentLimit: z.number().int().nonnegative().max(10_000_000).optional(),
  estimatedStayDays: z.number().int().positive().max(365).optional(),
});
export type CreateCaseRequest = z.infer<typeof CreateCaseRequestSchema>;

// PATCH /cases/:id — limited mutations: close, abandon, change assignee
// on the first claim. Status transitions on the claim itself go through
// the manual-transition endpoint (which delegates to ClaimService).
//
// T2-8 — also surfaces a single new field, currentRoomDailyRate, so
// the operator can record an ICU / higher-tier ward transfer
// mid-stay. Capped at the same ₹100k/day ceiling as the admission-
// time roomDailyRate. Nullable so the operator can clear it back to
// "not tracked" if the patient is moved back down.
export const UpdateCaseRequestSchema = z.object({
  caseStatus: z.enum(['open', 'closed', 'abandoned']).optional(),
  treatingDoctorId: z.string().uuid().nullable().optional(),
  currentRoomDailyRate: z.number().int().nonnegative().max(10_000_000).nullable().optional(),
});
export type UpdateCaseRequest = z.infer<typeof UpdateCaseRequestSchema>;

export const CaseSummarySchema = z.object({
  id: z.string().uuid(),
  patientName: z.string(),
  hospitalMrn: z.string(),
  admissionDate: z.string().date(),
  admissionType: z.enum(['planned', 'emergency', 'day_care']),
  primaryRail: ClaimRailSchema,
  caseStatus: z.enum(['open', 'closed', 'abandoned']),
  treatingDoctorId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
  // Headline status of the most recently-active claim — what the list
  // page shows in the status column.
  headlineClaimStatus: ClaimStatusSchema.nullable(),
  // T2-15 follow-up — IRDAI SLA state for the headline claim so the
  // /cases list cards can show pre-auth + claim pills without having
  // to fetch each case's detail. Optional because closed/abandoned
  // cases and rows whose headline claim never reached
  // preauth/claim submit have no SLA to draw.
  sla: ClaimSlaSchema.optional(),
  // T2-14 — room rent pre-warn fields captured at intake. Paise.
  // Null when not captured (emergency intake / self-pay / data-not-
  // available yet). Case-detail computes per-day + total liability
  // on the client from these values.
  roomDailyRate: z.number().int().nonnegative().nullable(),
  policyRoomRentLimit: z.number().int().nonnegative().nullable(),
  estimatedStayDays: z.number().int().positive().nullable(),
  // T2-8 — operator-updated current room rate (paise). When
  // higher than roomDailyRate the case-detail page auto-suggests
  // a preauth enhancement. Null = not yet tracked / unchanged
  // since admission.
  currentRoomDailyRate: z.number().int().nonnegative().nullable(),
  // Tier 2 — assignee of the most recently-active claim. Null
  // when unassigned OR when the headline claim hasn't been
  // claimed by any operator yet. Surfaced on the list cards so
  // a billing manager can scan team allocation at a glance.
  assignedToUserId: z.string().uuid().nullable(),
});
export type CaseSummary = z.infer<typeof CaseSummarySchema>;

export const CaseDetailSchema = CaseSummarySchema.extend({
  claims: z.array(ClaimSchema),
});
export type CaseDetail = z.infer<typeof CaseDetailSchema>;

export const ListCasesResponseSchema = z.object({
  cases: z.array(CaseSummarySchema),
  // Cursor pagination — Sprint 2 keeps it simple with offset+limit on
  // the server. The shape leaves room to swap to keyset-pagination
  // later without a wire break.
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type ListCasesResponse = z.infer<typeof ListCasesResponseSchema>;

// POST /cases/:caseId/claims/:claimId/transitions — admin escape hatch.
// Real production transitions come from the rail adapters (NHCX / PMJAY).
// Manual transitions exist for ops + initial smoke testing.
export const ManualTransitionRequestSchema = z.object({
  eventType: ClaimEventTypeSchema,
  payload: z.record(z.unknown()).optional(),
  // Optional materialised-state patch — same surface as ClaimService.transition.
  patch: z
    .object({
      preauthAmount: z.number().int().optional(),
      claimAmount: z.number().int().optional(),
      approvedAmount: z.number().int().optional(),
      paidAmount: z.number().int().optional(),
      preauthRefNum: z.string().optional(),
      claimRefNum: z.string().optional(),
      payerRefNum: z.string().optional(),
    })
    .optional(),
});
export type ManualTransitionRequest = z.infer<typeof ManualTransitionRequestSchema>;

export const ClaimEventListItemSchema = z.object({
  id: z.string().uuid(),
  eventType: ClaimEventTypeSchema,
  resultingStatus: ClaimStatusSchema,
  occurredAt: z.string().datetime(),
  recordedAt: z.string().datetime(),
  recordedById: z.string().uuid().nullable(),
  payload: z.record(z.unknown()),
});
export type ClaimEventListItem = z.infer<typeof ClaimEventListItemSchema>;

export const ClaimEventListResponseSchema = z.object({
  events: z.array(ClaimEventListItemSchema),
});
export type ClaimEventListResponse = z.infer<typeof ClaimEventListResponseSchema>;
