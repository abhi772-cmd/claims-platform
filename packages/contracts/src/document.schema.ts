import { z } from 'zod';

// Canonical document types. Listed here so the UI + checklist + filter
// menus all read off one source. Add new types as the document master
// matures (Sprint 2's Slice O).
export const DocumentTypeSchema = z.enum([
  'discharge_summary',
  'investigation_report',
  'implant_sticker',
  'OT_notes',
  'preauth_form',
  'final_bill',
  'EOB',
  'other',
]);
export type DocumentType = z.infer<typeof DocumentTypeSchema>;

export const DocumentUploadStatusSchema = z.enum(['pending', 'completed', 'failed']);
export type DocumentUploadStatus = z.infer<typeof DocumentUploadStatusSchema>;

// Independent of upload lifecycle. A row can be uploadStatus='completed'
// + scanStatus='pending' (finalize succeeded but the AV worker hasn't
// run yet) OR uploadStatus='completed' + scanStatus='infected' (the
// bytes are present in S3 but every consumer must reject them).
export const DocumentScanStatusSchema = z.enum([
  'pending',
  'clean',
  'infected',
  'skipped',
  'failed',
]);
export type DocumentScanStatus = z.infer<typeof DocumentScanStatusSchema>;

export const DocumentSchema = z.object({
  id: z.string().uuid(),
  claimId: z.string().uuid(),
  documentType: DocumentTypeSchema,
  storageBucket: z.string(),
  storageKey: z.string(),
  etag: z.string().nullable(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  originalFilename: z.string(),
  uploadStatus: DocumentUploadStatusSchema,
  contentSha256: z.string().nullable(),
  uploadError: z.string().nullable(),
  finalizedAt: z.string().datetime().nullable(),
  uploadedAt: z.string().datetime(),
  uploadedById: z.string().uuid().nullable(),
  scanStatus: DocumentScanStatusSchema,
  scanEngine: z.string().nullable(),
  scanSignature: z.string().nullable(),
  scannedAt: z.string().datetime().nullable(),
});
export type Document = z.infer<typeof DocumentSchema>;

// POST /cases/:c/claims/:cl/documents/upload-stub
// V1 stub — the real S3-presigned upload comes in Slice P. The stub
// accepts metadata and creates a Document row with a synthetic
// storage key so downstream flows (discharge submit, claim submit)
// have something to link.
export const UploadDocumentStubRequestSchema = z.object({
  documentType: DocumentTypeSchema,
  originalFilename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(120),
  sizeBytes: z.number().int().nonnegative().max(50 * 1024 * 1024),
});
export type UploadDocumentStubRequest = z.infer<typeof UploadDocumentStubRequestSchema>;

export const DocumentListResponseSchema = z.object({
  documents: z.array(DocumentSchema),
});
export type DocumentListResponse = z.infer<typeof DocumentListResponseSchema>;

// POST /cases/:c/claims/:cl/documents/upload-init — server allocates the
// storage key + signs a PUT URL; the client uploads bytes directly to S3
// and then calls finalize. The Document row is created in 'pending'
// state and only transitions to 'completed' on successful finalize.
export const UploadInitRequestSchema = z.object({
  documentType: DocumentTypeSchema,
  originalFilename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(120),
  sizeBytes: z.number().int().nonnegative().max(50 * 1024 * 1024),
});
export type UploadInitRequest = z.infer<typeof UploadInitRequestSchema>;

export const UploadInitResponseSchema = z.object({
  document: DocumentSchema,
  uploadUrl: z.string().url().or(z.string().startsWith('stub://')),
  expiresAt: z.string().datetime(),
  requiredHeaders: z.record(z.string()),
});
export type UploadInitResponse = z.infer<typeof UploadInitResponseSchema>;

// POST /cases/:c/claims/:cl/documents/:docId/eob-extract — operator-
// triggered EOB-OCR run. Wires the EobOcrAdapter (Slice AV) to the
// document so the settlement screen can pre-fill from extracted
// fields. Operators trigger this explicitly rather than auto-running
// at finalize so a heavy real-OCR call doesn't slow the upload path.
//
// `bufferBase64` is optional. Provided: the adapter scans those
// bytes directly (useful in stub-storage tests + cases where the
// client still has the buffer cached). Omitted: the adapter is
// expected to fetch the bytes from storage by (bucket, key); the
// stub-storage path will return `failed` since stub doesn't keep
// real bytes.
export const EobExtractRequestSchema = z.object({
  bufferBase64: z.string().max((5 * 1024 * 1024 * 4) / 3).optional(),
});
export type EobExtractRequest = z.infer<typeof EobExtractRequestSchema>;

export const EobExtractedDeductionSchema = z.object({
  category: z.string().min(1).max(64),
  amount: z.number().int().nonnegative(),
  reason: z.string().max(500).optional(),
});
export type EobExtractedDeduction = z.infer<typeof EobExtractedDeductionSchema>;

export const EobExtractedConfidenceSchema = z.object({
  claimRefNum: z.number().min(0).max(1).optional(),
  receivedAmount: z.number().min(0).max(1).optional(),
  deductionAmount: z.number().min(0).max(1).optional(),
  bankTxnId: z.number().min(0).max(1).optional(),
  receivedAt: z.number().min(0).max(1).optional(),
});
export type EobExtractedConfidence = z.infer<typeof EobExtractedConfidenceSchema>;

export const EobExtractedFieldsSchema = z.object({
  claimRefNum: z.string().optional(),
  receivedAmount: z.number().int().nonnegative().optional(),
  deductionAmount: z.number().int().nonnegative().optional(),
  deductions: z.array(EobExtractedDeductionSchema),
  shortPaymentReasons: z.array(z.string()),
  bankTxnId: z.string().optional(),
  receivedAt: z.string().datetime().optional(),
  confidence: EobExtractedConfidenceSchema.optional(),
});
export type EobExtractedFields = z.infer<typeof EobExtractedFieldsSchema>;

export const EobExtractStatusSchema = z.enum([
  'extracted',
  'low_confidence',
  'skipped',
  'failed',
]);
export type EobExtractStatus = z.infer<typeof EobExtractStatusSchema>;

export const EobExtractResponseSchema = z.object({
  status: EobExtractStatusSchema,
  engine: z.string(),
  fields: EobExtractedFieldsSchema.optional(),
  error: z.string().optional(),
});
export type EobExtractResponse = z.infer<typeof EobExtractResponseSchema>;

// POST /cases/:c/claims/:cl/documents/:docId/finalize — client completed
// the PUT, server HEADs the object to confirm + capture etag/size.
export const UploadFinalizeRequestSchema = z.object({
  // sha256 of the uploaded bytes. Optional in V1 stub flows; the
  // discharge / claim-submit gates accept rows without it. Required at
  // production hardening (Sprint 5) once the web client computes it
  // before PUT.
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  // Optional bytes for the in-process stub virus scanner (base64-
  // encoded). Real-mode scanners stream from S3 by (bucket, key) so
  // this field is unused in production. Capped at 5 MiB after base64
  // decode — anything larger should use the streaming path.
  scanBufferBase64: z.string().max((5 * 1024 * 1024 * 4) / 3).optional(),
});
export type UploadFinalizeRequest = z.infer<typeof UploadFinalizeRequestSchema>;
