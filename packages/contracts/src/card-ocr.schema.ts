import { z } from 'zod';

// Card-OCR — operator scans a patient's health-insurance / TPA card
// (PDF / image) at intake and gets back the printed fields to pre-fill
// the new-case form (insurer/payer, policy number, insured name, etc.).
// Stateless: no Document row, nothing persisted. The bytes are
// forwarded to the OCR machine's /extract-card route (same machine as
// EOB / bill OCR).
//
// POST /eligibility/extract-card  (pre-case, CASE_CREATE-gated)

const MAX_CARD_FILE_BYTES = 10 * 1024 * 1024;

export const CardOcrExtractRequestSchema = z.object({
  fileBase64: z.string().min(1).max((MAX_CARD_FILE_BYTES * 4) / 3),
  contentType: z.string().min(1).max(120),
  originalFilename: z.string().min(1).max(255).optional(),
});
export type CardOcrExtractRequest = z.infer<typeof CardOcrExtractRequestSchema>;

// Fields read off the card. All optional — the engine returns whatever
// it could read and the intake form pre-fills the matching inputs.
// `sumInsuredPaise` is an int in paise. Date fields are free strings
// (the model is asked for ISO YYYY-MM-DD but we don't hard-validate —
// the operator reviews before submit).
export const CardOcrFieldsSchema = z.object({
  insurerName: z.string().optional(),
  tpaName: z.string().optional(),
  policyNumber: z.string().optional(),
  memberId: z.string().optional(),
  insuredName: z.string().optional(),
  sumInsuredPaise: z.number().int().nonnegative().optional(),
  validFrom: z.string().optional(),
  validTo: z.string().optional(),
  dateOfBirth: z.string().optional(),
});
export type CardOcrFields = z.infer<typeof CardOcrFieldsSchema>;

export const CardOcrExtractStatusSchema = z.enum([
  'extracted',
  'low_confidence',
  'skipped',
  'failed',
]);
export type CardOcrExtractStatus = z.infer<typeof CardOcrExtractStatusSchema>;

export const CardOcrExtractResponseSchema = z.object({
  status: CardOcrExtractStatusSchema,
  engine: z.string(),
  fields: CardOcrFieldsSchema.optional(),
  error: z.string().optional(),
});
export type CardOcrExtractResponse = z.infer<typeof CardOcrExtractResponseSchema>;
