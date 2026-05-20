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
  // Verbal-then-countersigned grant where the witness acknowledgement
  // has landed but the patient/next-of-kin counter-signature has not
  // yet arrived. Treated as NON-ACTIVE by findActiveFor() — the gate
  // fails-closed until status flips to 'granted' (via countersign) or
  // 'superseded' (via 24h sweeper).
  'pending_countersign',
]);
export type ConsentStatus = z.infer<typeof ConsentStatusSchema>;

// Slice CM — operator-facing menu of how consent was captured.
//   otp                  → patient receives SMS code, types it back
//                          (default path; works for any patient with a
//                          mobile)
//   verbal_countersigned → two-witness verbal capture at bedside,
//                          counter-signed paper artifact uploaded
//                          within 24h (emergency / illiterate /
//                          no-mobile path)
//   abha_hie_cm          → request routed through ABDM HIE-CM; patient
//                          approves in their ABHA app (premium path,
//                          visible only when patient has abhaId)
//
// Each value pairs with a per-method evidence sub-schema below and an
// optional artifact row (consent_otp / consent_verbal /
// consent_abha_request) keyed off ConsentRecord.acknowledgementRef.
export const AcknowledgementMethodSchema = z.enum([
  'otp',
  'verbal_countersigned',
  'abha_hie_cm',
]);
export type AcknowledgementMethod = z.infer<typeof AcknowledgementMethodSchema>;

// Snapshot of the notice the data principal saw at consent time.
// Verbatim copy preserved so a later DPDP audit can reconstruct
// what they agreed to.
//
// `acknowledgedVia` is kept as free-text for backward compatibility
// with existing rows (legacy values like 'in_person_signature' /
// 'paper_form_doc:<id>' / 'tele_consent_call:<id>'). New capture flows
// MUST also set `ConsentRecord.acknowledgementMethod` to one of the
// typed values above and (optionally) point `acknowledgementRef` at
// the per-method artifact row.
export const ConsentEvidenceSchema = z.object({
  noticeText: z.string().min(1).max(20000),
  acknowledgedVia: z.string().min(1).max(500),
  // Optional list of locale tags the notice was rendered in
  // ('en-IN', 'hi-IN'). Helps the audit story when a tenant
  // operates multilingual desks.
  locales: z.array(z.string().min(2).max(20)).optional(),
  // Slice CM — per-method evidence payloads. Exactly one of these
  // should be populated and must match ConsentRecord.acknowledgementMethod.
  // Stored inside `evidence` JSON (not as separate columns) so the
  // audit snapshot is one round-trip and old rows remain readable.
  otp: z
    .object({
      otpId: z.string().uuid(),
      mobileLast4: z.string().length(4),
      sentAt: z.string().datetime(),
      verifiedAt: z.string().datetime(),
      gatewayMessageId: z.string().max(200).nullable(),
    })
    .optional(),
  verbal: z
    .object({
      witness1UserId: z.string().uuid(),
      witness2UserId: z.string().uuid(),
      reasonCode: z.enum([
        'emergency_admission',
        'patient_unable_to_sign',
        'illiterate_thumbprint',
        'mobile_unavailable',
        'other',
      ]),
      verbalTranscript: z.string().min(1).max(2000),
      capturedAt: z.string().datetime(),
      countersignDeadline: z.string().datetime(),
    })
    .optional(),
  abha: z
    .object({
      hieCmRequestId: z.string().min(1).max(200),
      abhaIdLast4: z.string().length(4),
      requestedAt: z.string().datetime(),
      approvedAt: z.string().datetime(),
      granularity: z
        .object({
          dataCategories: z.array(z.string()),
          hiTypes: z.array(z.string()).optional(),
          expiresAt: z.string().datetime().optional(),
        })
        .optional(),
    })
    .optional(),
});
export type ConsentEvidence = z.infer<typeof ConsentEvidenceSchema>;

// Slice CM — OTP initiation request. Operator clicks "Send OTP".
// Backend mints a 6-digit code, hashes it, persists with TTL, and
// dispatches via the existing TextGuru SMS path. Response includes
// the otpId the operator carries into the verify call.
//
// Note: OTP is keyed off the mobile number, not patientId — the
// intake form creates the patient row at case-submit time, AFTER
// consent is captured. The case-create path validates the verified
// otpId before the consent_record commits.
export const ConsentOtpInitiateSchema = z.object({
  // E.164-ish mobile, same shape PatientPiiInputSchema accepts.
  mobile: z.string().regex(/^\+?[0-9]{8,15}$/),
  consentType: ConsentTypeSchema,
  // Verbatim notice the patient must have agreed to. Locked at
  // initiate time so a later notice-text edit can't retroactively
  // change what the patient saw.
  noticeText: z.string().min(1).max(20000),
  locales: z.array(z.string().min(2).max(20)).optional(),
});
export type ConsentOtpInitiateRequest = z.infer<typeof ConsentOtpInitiateSchema>;

export const ConsentOtpInitiateResponseSchema = z.object({
  otpId: z.string().uuid(),
  mobileLast4: z.string().length(4),
  expiresAt: z.string().datetime(),
});
export type ConsentOtpInitiateResponse = z.infer<typeof ConsentOtpInitiateResponseSchema>;

// Slice CM — OTP verification request. Two-step pattern: verify the
// code first (no consent row yet), then the case-create flow attaches
// the verified otpId via GrantConsent. This split lets the operator
// retry the OTP without re-opening the case form.
export const ConsentOtpVerifySchema = z.object({
  otpId: z.string().uuid(),
  code: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits'),
});
export type ConsentOtpVerifyRequest = z.infer<typeof ConsentOtpVerifySchema>;

export const ConsentOtpVerifyResponseSchema = z.object({
  otpId: z.string().uuid(),
  verifiedAt: z.string().datetime(),
});
export type ConsentOtpVerifyResponse = z.infer<typeof ConsentOtpVerifyResponseSchema>;

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
  // Slice CM — typed method enum. Optional so legacy intake paths
  // (tests, seed) that only set `source` keep working. Required when
  // the per-method artifact tables are involved (OTP/verbal/ABHA).
  acknowledgementMethod: AcknowledgementMethodSchema.optional(),
  // FK into consent_otp / consent_verbal / consent_abha_request,
  // depending on `acknowledgementMethod`. The service layer enforces
  // the consistency (a method='otp' grant must carry a
  // consent_otp.id ref).
  acknowledgementRef: z.string().uuid().optional(),
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
  acknowledgementMethod: AcknowledgementMethodSchema.nullable(),
  acknowledgementRef: z.string().uuid().nullable(),
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
