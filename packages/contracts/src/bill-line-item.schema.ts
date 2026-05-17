import { z } from 'zod';

import { NonMedicalCategorySchema } from './non-medical-classifier.schema';

// T2-13 follow-up — persisted bill line items.
//
// Yesterday's calculator was stateless. This contract gives the
// classified bill a durable home so:
//   * the operator can come back later without re-typing
//   * the EOB-line matcher (separate slice) can map our lines to
//     payer deductions when the EOB lands
//   * the audit trail captures what the hospital actually claimed
//
// Save semantics are replace-all: each POST replaces the whole set
// for the claim. We do not surface per-row PATCH because the
// calculator-UX is "paste the bill, save the bill" — a per-row API
// would be a UX shape we haven't built and don't currently need.

export const BillLineItemSchema = z.object({
  id: z.string().uuid(),
  description: z.string(),
  amountPaise: z.number().int().nonnegative(),
  // The operator's FINAL tag (may differ from the classifier's
  // current opinion if they overrode in the UI).
  medical: z.boolean(),
  // Non-medical category. Null when medical = true.
  category: NonMedicalCategorySchema.nullable(),
  // Classifier hint at save time. Null when medical = true OR when
  // the operator overrode the classifier's miss with a manual tag.
  matchedTerm: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type BillLineItem = z.infer<typeof BillLineItemSchema>;

// One row in the save payload — same shape as the persisted row
// minus the server-assigned fields (id, createdAt).
export const SaveBillLineItemSchema = z.object({
  description: z.string().min(1).max(300),
  amountPaise: z.number().int().nonnegative().max(50_00_00_000), // ₹50 lakh ceiling
  medical: z.boolean(),
  category: NonMedicalCategorySchema.nullable().optional(),
  matchedTerm: z.string().max(300).nullable().optional(),
});
export type SaveBillLineItem = z.infer<typeof SaveBillLineItemSchema>;

export const SaveBillLineItemsRequestSchema = z.object({
  // 0..500 — 0 is intentional (operator can clear the saved bill
  // by saving an empty set). 500 is a sanity ceiling against
  // accidental paste of a huge file.
  lines: z.array(SaveBillLineItemSchema).max(500),
});
export type SaveBillLineItemsRequest = z.infer<
  typeof SaveBillLineItemsRequestSchema
>;

export const BillLineItemsListResponseSchema = z.object({
  lines: z.array(BillLineItemSchema),
  // Server-computed totals so the UI can display headlines without
  // re-summing. Same shape as the classifier endpoint's totals.
  totals: z.object({
    medicalPaise: z.number().int().nonnegative(),
    nonMedicalPaise: z.number().int().nonnegative(),
    grandTotalPaise: z.number().int().nonnegative(),
  }),
});
export type BillLineItemsListResponse = z.infer<
  typeof BillLineItemsListResponseSchema
>;
