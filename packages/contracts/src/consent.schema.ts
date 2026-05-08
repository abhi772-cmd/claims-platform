// Slice BT — DPDP Act 2023 §6 / Rule 8 consent record contracts.
//
// The platform captures consent at admission (or on a per-purpose
// basis later) and binds every PII read back to the grant that
// authorised it. Service callers gate reads through
// `consentService.requireConsent(patientId, consentType)`.
//
// `consentType` is the high-level grant scope (NHCX vs PMJAY vs
// analytics vs communication); `purposes` is the finer-grained
// vocabulary that data_access_event.purpose round-trips through.

import { z } from 'zod';

// Conservative initial taxonomy. Add new types here first; new
// types are non-breaking as long as the seed roles + UI handle
// them as opaque strings.
export const ConsentTypeSchema = z.enum([
  // Private rail (NHCX) processing — eligibility / preauth / claim.
  'nhcx_processing',
  // PMJAY rail processing — same flow but governed by PMJAY rules.
  'pmjay_processing',
  // Internal analytics, BU dashboards, denial-pattern reports.
  'analytics',
  // Outbound communications (SMS, email reminders, status updates).
  'communication',
]);
export type ConsentType = z.infer<typeof ConsentTypeSchema>;

export const LawfulBasisSchema = z.enum([
  'consent',
  'legitimate_use',
  'legal_obligation',
  'public_interest',
]);
export type LawfulBasis = z.infer<typeof LawfulBasisSchema>;

export const ConsentStatusSchema = z.enum([
  'granted',
  'withdrawn',
  'expired',
  'superseded',
]);
export type ConsentStatus = z.infer<typeof ConsentStatusSchema>;

// Snapshot of the notice the data principal saw at consent time.
// Verbatim copy preserved so a later DPDP audit can reconstruct
// what they agreed to.
export const ConsentEvidenceSchema = z.object({
  noticeText: z.string().min(1).max(20000),
  // Free-text describing how the principal acknowledged the notice
  // (signed paper form, OTP confirmation, verbal-then-counter-signed,
  // etc.). Required so the audit story isn't ambiguous.
  acknowledgedVia: z.string().min(1).max(500),
  // Optional list of locale tags the notice was rendered in
  // ('en-IN', 'hi-IN'). Helps the audit story when a tenant
  // operates multilingual desks.
  locales: z.array(z.string().min(2).max(20)).optional(),
});
export type ConsentEvidence = z.infer<typeof ConsentEvidenceSchema>;

export const GrantConsentSchema = z.object({
  patientId: z.string().uuid(),
  consentType: ConsentTypeSchema,
  // Per-grant data + purpose scope. Empty arrays land an
  // implicit "covers everything the consentType implies" but
  // we require at least one entry so the record is auditable.
  dataCategories: z.array(z.string().min(1).max(64)).min(1).max(32),
  purposes: z.array(z.string().min(1).max(64)).min(1).max(32),
  lawfulBasis: LawfulBasisSchema.default('consent'),
  // 'in_person' | 'abha_otp' | 'paper_form_doc:<docId>' | etc.
  source: z.string().min(1).max(500),
  evidence: ConsentEvidenceSchema,
  expiresAt: z.string().datetime().optional(),
  documentId: z.string().uuid().optional(),
});
export type GrantConsent = z.infer<typeof GrantConsentSchema>;

export const WithdrawConsentSchema = z.object({
  // Required — DPDP §13 traceability. The reason is captured so
  // the access-history dashboard can explain why a previously
  // valid grant is no longer authorising reads.
  reason: z.string().min(5).max(2000),
});
export type WithdrawConsent = z.infer<typeof WithdrawConsentSchema>;

export const ConsentRecordRowSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  patientId: z.string().uuid(),
  consentType: ConsentTypeSchema,
  dataCategories: z.array(z.string()),
  purposes: z.array(z.string()),
  lawfulBasis: LawfulBasisSchema,
  status: ConsentStatusSchema,
  source: z.string(),
  evidence: ConsentEvidenceSchema,
  grantedAt: z.string(),
  expiresAt: z.string().nullable(),
  withdrawnAt: z.string().nullable(),
  withdrawalReason: z.string().nullable(),
  capturedByUserId: z.string().uuid().nullable(),
  documentId: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ConsentRecordRow = z.infer<typeof ConsentRecordRowSchema>;

export const ConsentListFilterSchema = z.object({
  patientId: z.string().uuid().optional(),
  consentType: ConsentTypeSchema.optional(),
  status: ConsentStatusSchema.optional(),
});
export type ConsentListFilter = z.infer<typeof ConsentListFilterSchema>;

export const ConsentListResponseSchema = z.object({
  rows: z.array(ConsentRecordRowSchema),
  total: z.number().int().nonnegative(),
});
export type ConsentListResponse = z.infer<typeof ConsentListResponseSchema>;
