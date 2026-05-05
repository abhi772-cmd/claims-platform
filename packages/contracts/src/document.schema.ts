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
  uploadedAt: z.string().datetime(),
  uploadedById: z.string().uuid().nullable(),
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
