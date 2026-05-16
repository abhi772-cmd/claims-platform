import { z } from 'zod';

// T2-13 — non-medical auto-strip classifier.
//
// Indian health policies routinely exclude a long list of non-medical
// items from cashless reimbursement (toiletries, attendant meals,
// registration / record fees, transport, TV / phone / newspaper
// rentals, etc.). When the hospital submits a claim that includes
// these line items, the payer strips them on the EOB and the family
// finds out at discharge / settlement. T2-13's job is to catch the
// strip BEFORE the claim is submitted so the operator can:
//   - exclude the line items from finalAmount (cleanest), or
//   - get explicit acceptance from the family for the differential.
//
// Pure-function lookup over a comprehensive Indian-hospital keyword
// catalog. The classifier is informational — it doesn't mutate the
// claim or persist anything. The operator types the agreed
// finalAmount into ClaimPhasePanel below.

// One row of the bill the operator pastes / types into the calculator.
// Description is free-form; amount is in paise (Int) to match the
// existing money convention. Operator-side input is rupees; the web
// component converts before POST.
export const BillLineSchema = z.object({
  description: z.string().min(1).max(300),
  amountPaise: z.number().int().nonnegative(),
});
export type BillLine = z.infer<typeof BillLineSchema>;

export const ClassifyNonMedicalRequestSchema = z.object({
  lines: z.array(BillLineSchema).min(1).max(500),
});
export type ClassifyNonMedicalRequest = z.infer<typeof ClassifyNonMedicalRequestSchema>;

// Per-line classification. `category` is the canonical token from the
// matched rule (e.g. 'toiletries', 'attendant_food', 'registration').
// `medical: true` means "no rule matched, treat as medical until
// proven otherwise" — conservative default; the operator can still
// override in the UI.
export const NonMedicalCategorySchema = z.enum([
  'toiletries',
  'attendant_food',
  'attendant_stay',
  'admin_fees',
  'transport',
  'comfort',
  'documentation',
  'miscellaneous_consumables',
  'miscellaneous',
]);
export type NonMedicalCategory = z.infer<typeof NonMedicalCategorySchema>;

export const ClassifiedLineSchema = z.object({
  description: z.string(),
  amountPaise: z.number().int().nonnegative(),
  medical: z.boolean(),
  category: NonMedicalCategorySchema.nullable(),
  // The exact keyword/phrase that triggered the match — surfaced in
  // the UI as "matched: ‹toiletries / soap›" so the operator can sanity
  // check the rule rather than trust a black box.
  matchedTerm: z.string().nullable(),
});
export type ClassifiedLine = z.infer<typeof ClassifiedLineSchema>;

export const ClassifyNonMedicalResponseSchema = z.object({
  lines: z.array(ClassifiedLineSchema),
  totals: z.object({
    medicalPaise: z.number().int().nonnegative(),
    nonMedicalPaise: z.number().int().nonnegative(),
    grandTotalPaise: z.number().int().nonnegative(),
  }),
  // Breakdown by category for the operator-facing summary card.
  byCategory: z.array(
    z.object({
      category: NonMedicalCategorySchema,
      count: z.number().int().nonnegative(),
      amountPaise: z.number().int().nonnegative(),
    }),
  ),
});
export type ClassifyNonMedicalResponse = z.infer<typeof ClassifyNonMedicalResponseSchema>;
