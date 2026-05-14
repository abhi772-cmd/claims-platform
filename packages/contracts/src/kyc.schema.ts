import { z } from 'zod';

// Slice ON-2 of the onboarding spec diff (docs/15) — Stage-3 KYC
// document upload. Mirrors the existing document.schema upload-init
// + finalize pattern so the web client uploads bytes direct to S3
// rather than streaming through the API server.

// Six KYC artefacts NHA + IRDAI evidence at onboarding plus the two
// platform-side legal agreements (DPA, MSA). The first six are the
// `kyc_documents_uploaded` step; the legal pair lands in slice ON-3
// with the signed-PDF re-upload + e-signature abstraction.
export const KycDocumentTypeSchema = z.enum([
  'hospital_registration',
  'rohini_registration',
  'gst_certificate',
  'pan',
  'signatory_id',
  'cancelled_cheque',
  'dpa_signed',
  'msa_signed',
]);
export type KycDocumentType = z.infer<typeof KycDocumentTypeSchema>;

// The six types that gate the kyc_documents_uploaded step. Exported
// so the UI can render the checklist + the readiness/service code
// share one source of truth.
export const REQUIRED_KYC_DOCUMENT_TYPES: readonly KycDocumentType[] = [
  'hospital_registration',
  'rohini_registration',
  'gst_certificate',
  'pan',
  'signatory_id',
  'cancelled_cheque',
];

// The two types that gate the legal_agreements_signed step. v1 flow
// is "download the unsigned PDF, sign physically / via your own
// e-signature provider, re-upload" — same upload pipeline as the
// KYC docs. A dedicated e-signature provider abstraction is a
// v2 concern (docs/15 open question #1).
export const LEGAL_AGREEMENT_DOCUMENT_TYPES: readonly KycDocumentType[] = [
  'dpa_signed',
  'msa_signed',
];

export const KycDocumentStatusSchema = z.enum([
  'uploading',
  'pending_review',
  'approved',
  'rejected',
  'resubmission_requested',
]);
export type KycDocumentStatus = z.infer<typeof KycDocumentStatusSchema>;

// Allowed content types on upload. PDFs are the dominant case; JPG /
// PNG covers photo'd-on-phone scans. We intentionally exclude DOCX
// and proprietary office formats — ops review needs to actually
// open the file, and PDFs render uniformly across reviewer browsers.
export const KYC_ALLOWED_CONTENT_TYPES: readonly string[] = [
  'application/pdf',
  'image/jpeg',
  'image/png',
];

// 25 MiB is generous for a scan; pushes through OVH OCI uplinks
// without timeouts. Anything bigger usually means the user scanned
// at print resolution — we'd rather they re-scan than retry on
// faulty Wi-Fi.
export const KYC_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// Soft SLA — ops aim to review a freshly-uploaded KYC document
// inside 48h of `uploadedAt`. The number is baked in here (not a
// column on the row) because per-doc SLA overrides are not on the
// roadmap; a single platform-wide promise simplifies the queue UI
// and the breach surfacing. Breach surfaces as a red banner on
// both tenant + ops views; there is no automated breach action
// (docs/15 open question #4 — left to ops process for v1).
export const KYC_SLA_TARGET_HOURS = 48;
const KYC_SLA_WARN_HOURS = 36; // amber from 75% of the window

export const KycSlaStateSchema = z.enum(['on_track', 'warning', 'breached']);
export type KycSlaState = z.infer<typeof KycSlaStateSchema>;

// Pure, deterministic — same input → same output. Lives in
// contracts so server + UI compute identically without a network
// round-trip just to surface a colour.
export function computeKycSlaState(args: {
  uploadedAt: string;
  status: KycDocumentStatus;
  now?: string;
}): KycSlaState {
  // Once ops acts on the row the SLA window closes.
  if (
    args.status === 'approved' ||
    args.status === 'rejected' ||
    args.status === 'resubmission_requested'
  ) {
    return 'on_track';
  }
  const uploaded = new Date(args.uploadedAt).getTime();
  const now = new Date(args.now ?? new Date().toISOString()).getTime();
  const ageHours = (now - uploaded) / 3_600_000;
  if (ageHours >= KYC_SLA_TARGET_HOURS) return 'breached';
  if (ageHours >= KYC_SLA_WARN_HOURS) return 'warning';
  return 'on_track';
}

export const KycDocumentSchema = z.object({
  id: z.string().uuid(),
  documentType: KycDocumentTypeSchema,
  status: KycDocumentStatusSchema,
  originalFilename: z.string(),
  contentType: z.string(),
  declaredSizeBytes: z.number().int().nonnegative(),
  actualSizeBytes: z.number().int().nonnegative().nullable(),
  sha256: z.string().nullable(),
  uploadedAt: z.string().datetime(),
  finalizedAt: z.string().datetime().nullable(),
  // Slice ON-3 — derived from uploadedAt + KYC_SLA_TARGET_HOURS.
  // Stays at on_track once ops has acted (the window closes).
  slaState: KycSlaStateSchema,
  // Review fields populated once ops acts on the row.
  reviewedAt: z.string().datetime().nullable(),
  reviewNotes: z.string().nullable(),
  rejectionReasonCode: z.string().nullable(),
});
export type KycDocument = z.infer<typeof KycDocumentSchema>;

// GET /tenant/kyc → list-with-summary. The `requiredCoverage` map
// lets the UI render the checklist without a second round-trip.
// Two coverage axes (kyc, legal) and two readiness flags (uploaded,
// approved) so the UI can render four distinct affordances:
//   - upload checklist (non-rejected row exists)
//   - "awaiting review" countdown (pending_review present)
//   - "ops approved" green check (approved)
//   - "re-upload requested" red banner (rejected / resubmission_requested)
export const KycListResponseSchema = z.object({
  documents: z.array(KycDocumentSchema),
  // True when every required KYC type has at least one non-rejected row.
  requiredCoverageComplete: z.boolean(),
  // Per-type coverage flag for the KYC checklist (six required types).
  requiredCoverage: z.record(KycDocumentTypeSchema, z.boolean()),
  // True when both dpa_signed and msa_signed have non-rejected rows.
  legalCoverageComplete: z.boolean(),
  // Per-type coverage flag for the two legal agreement types.
  legalCoverage: z.record(KycDocumentTypeSchema, z.boolean()),
  // True when every required + legal type has an `approved` row.
  // Drives the `kyc_verified_by_ops` derived onboarding step.
  opsVerificationComplete: z.boolean(),
});
export type KycListResponse = z.infer<typeof KycListResponseSchema>;

// POST /tenant/kyc/upload-init — same shape as the existing document
// upload-init. Server allocates storage key + signs PUT URL, creates
// row in `uploading`. Client uploads bytes direct, then calls finalize.
export const KycUploadInitRequestSchema = z.object({
  documentType: KycDocumentTypeSchema,
  originalFilename: z.string().min(1).max(255),
  contentType: z
    .string()
    .min(1)
    .max(120)
    .refine((v) => KYC_ALLOWED_CONTENT_TYPES.includes(v), {
      message: 'Only PDF, JPEG, and PNG uploads are accepted for KYC.',
    }),
  sizeBytes: z.number().int().positive().max(KYC_MAX_UPLOAD_BYTES),
});
export type KycUploadInitRequest = z.infer<typeof KycUploadInitRequestSchema>;

export const KycUploadInitResponseSchema = z.object({
  document: KycDocumentSchema,
  uploadUrl: z.string().url().or(z.string().startsWith('stub://')),
  expiresAt: z.string().datetime(),
  requiredHeaders: z.record(z.string()),
});
export type KycUploadInitResponse = z.infer<typeof KycUploadInitResponseSchema>;

// POST /tenant/kyc/:id/finalize — client completed the PUT; server
// HEADs the object, captures etag + actual size, flips status to
// `pending_review`.
export const KycUploadFinalizeRequestSchema = z.object({
  contentSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
});
export type KycUploadFinalizeRequest = z.infer<typeof KycUploadFinalizeRequestSchema>;

// GET /tenant/kyc/:id/download-url — tenant-side preview before ops
// reviews. Short-lived presigned GET. Forbidden once the row is in
// rejected status (the bytes are still there for ops audit, but the
// tenant should re-upload rather than re-download).
export const KycDownloadResponseSchema = z.object({
  url: z.string().url().or(z.string().startsWith('stub://')),
  expiresAt: z.string().datetime(),
});
export type KycDownloadResponse = z.infer<typeof KycDownloadResponseSchema>;

// =====================================================
// Ops review queue (platform_admin only)
// =====================================================

// One row in the queue — includes tenant context so ops doesn't need
// a per-row lookup to render "Apollo Hospitals Indore — GST cert
// uploaded 18h ago".
export const KycReviewQueueItemSchema = z.object({
  document: KycDocumentSchema,
  tenantId: z.string().uuid(),
  tenantDisplayName: z.string(),
  tenantSlug: z.string(),
  // Surfaced in ISO so the UI can render absolute timestamps + a
  // relative tooltip without renegotiating the timezone.
  uploadedAt: z.string().datetime(),
});
export type KycReviewQueueItem = z.infer<typeof KycReviewQueueItemSchema>;

// GET /admin/kyc/queue?status=pending_review&limit=50&offset=0
// Default status filter is pending_review (the natural queue).
// All other statuses are addressable for the per-tenant deep-dive
// view ("show me everything I've already approved for tenant X").
export const KycReviewQueueQuerySchema = z.object({
  status: KycDocumentStatusSchema.optional(),
  tenantId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type KycReviewQueueQuery = z.infer<typeof KycReviewQueueQuerySchema>;

export const KycReviewQueueResponseSchema = z.object({
  items: z.array(KycReviewQueueItemSchema),
  total: z.number().int().nonnegative(),
});
export type KycReviewQueueResponse = z.infer<typeof KycReviewQueueResponseSchema>;

// GET /admin/kyc/:id — single document for the review screen.
// Includes the presigned download URL so ops can open the file in
// one round-trip; the URL is short-lived (matches the tenant
// download presign).
export const KycReviewDetailSchema = z.object({
  item: KycReviewQueueItemSchema,
  download: KycDownloadResponseSchema,
});
export type KycReviewDetail = z.infer<typeof KycReviewDetailSchema>;

// POST /admin/kyc/:id/review — apply an action.
// approve: row → approved. No notes required.
// reject: row → rejected. Hard stop — tenant must re-upload a new row.
//         Requires rejectionReasonCode for analytics + tenant-facing copy.
// request_resubmission: row → resubmission_requested. Softer than
//         reject; the UI prompts the tenant with the notes inline.
//         Requires rejectionReasonCode + free-text notes.
export const KycReviewActionSchema = z.enum([
  'approve',
  'reject',
  'request_resubmission',
]);
export type KycReviewAction = z.infer<typeof KycReviewActionSchema>;

export const KycReviewRequestSchema = z
  .object({
    action: KycReviewActionSchema,
    notes: z.string().min(1).max(1000).optional(),
    rejectionReasonCode: z.string().min(1).max(64).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.action === 'reject' || val.action === 'request_resubmission') {
      if (!val.rejectionReasonCode) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rejectionReasonCode'],
          message: 'rejectionReasonCode is required for reject + request_resubmission.',
        });
      }
    }
    if (val.action === 'request_resubmission' && !val.notes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['notes'],
        message: 'notes is required for request_resubmission so the tenant knows what to redo.',
      });
    }
  });
export type KycReviewRequest = z.infer<typeof KycReviewRequestSchema>;

// A stable, ops-facing list of common rejection reasons. Free-text
// for now since the analytics use case is "what rejected the most
// last quarter" — a hardcoded enum would force a deploy every time
// ops invents a new reason. Validated only by length.
export const KYC_REJECTION_REASON_HINTS: readonly string[] = [
  'illegible_scan',
  'expired_document',
  'wrong_document_type',
  'name_mismatch',
  'incomplete_pages',
  'tampered_appearance',
  'other',
];
