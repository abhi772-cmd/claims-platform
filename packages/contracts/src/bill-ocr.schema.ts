import { z } from 'zod';

import { BillLineSchema } from './non-medical-classifier.schema';

// Bill-OCR — operator uploads a hospital final bill (PDF / image) and
// gets back parsed line items to seed the non-medical classifier
// (T2-13), replacing the paste-as-text step. Stateless: no Document
// row is created and nothing is persisted. The bytes are forwarded to
// the bill-OCR inference service (the eob-ocr-machine's /extract-bill
// route — same machine as EOB OCR, different endpoint).
//
// POST /discharge/extract-bill

// 10 MB file cap. base64 inflates ~33%, so the encoded-string cap is
// fileBytes * 4 / 3. Bills are typically well under this.
const MAX_BILL_FILE_BYTES = 10 * 1024 * 1024;

export const BillOcrExtractRequestSchema = z.object({
  // base64-encoded bill bytes (the browser reads the chosen file and
  // encodes it before POST).
  fileBase64: z.string().min(1).max((MAX_BILL_FILE_BYTES * 4) / 3),
  contentType: z.string().min(1).max(120),
  originalFilename: z.string().min(1).max(255).optional(),
});
export type BillOcrExtractRequest = z.infer<typeof BillOcrExtractRequestSchema>;

// Mirrors the EOB extract status set. 'skipped' = the adapter is in
// 'off' mode; 'low_confidence' = engine ran but read nothing usable;
// 'failed' = engine error (operator falls back to paste / manual).
export const BillOcrExtractStatusSchema = z.enum([
  'extracted',
  'low_confidence',
  'skipped',
  'failed',
]);
export type BillOcrExtractStatus = z.infer<typeof BillOcrExtractStatusSchema>;

export const BillOcrExtractResponseSchema = z.object({
  status: BillOcrExtractStatusSchema,
  // Free-form engine identifier ('disabled', 'stub', 'ollama:qwen2.5vl:7b'…)
  // so we can tell which engine produced an extraction.
  engine: z.string(),
  // Parsed bill rows in the same shape the classifier consumes
  // (description + amountPaise). Empty on skipped / low_confidence /
  // failed.
  lines: z.array(BillLineSchema),
  error: z.string().optional(),
});
export type BillOcrExtractResponse = z.infer<typeof BillOcrExtractResponseSchema>;
