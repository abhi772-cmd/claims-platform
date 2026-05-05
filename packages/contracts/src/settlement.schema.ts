import { z } from 'zod';

export const PaymentModeSchema = z.enum([
  'cashless_tpa',
  'patient_oop',
  'reimbursement',
  'pmjay_disbursement',
]);
export type PaymentMode = z.infer<typeof PaymentModeSchema>;

export const ReconciliationStatusSchema = z.enum([
  'auto_matched',
  'manual_match_pending',
  'short_paid',
  'discrepancy',
]);
export type ReconciliationStatus = z.infer<typeof ReconciliationStatusSchema>;

export const DeductionLineSchema = z.object({
  category: z.string().min(1).max(64),
  amount: z.number().int().nonnegative(),
  reason: z.string().max(500).optional(),
});
export type DeductionLine = z.infer<typeof DeductionLineSchema>;

export const SettlementSchema = z.object({
  id: z.string().uuid(),
  claimId: z.string().uuid(),
  paymentMode: PaymentModeSchema,
  expectedAmount: z.number().int().nonnegative(),
  receivedAmount: z.number().int().nonnegative().nullable(),
  deductionAmount: z.number().int().nonnegative().nullable(),
  deductions: z.array(DeductionLineSchema),
  receivedAt: z.string().datetime().nullable(),
  eobDocumentId: z.string().uuid().nullable(),
  reconciliationStatus: ReconciliationStatusSchema,
  shortPaymentReasons: z.array(z.string()),
  closedAt: z.string().datetime().nullable(),
});
export type Settlement = z.infer<typeof SettlementSchema>;

// POST /settlement/expect — fired automatically on claim approval but
// also exposed for ops + tests.
export const ExpectPaymentRequestSchema = z.object({
  paymentMode: PaymentModeSchema,
  expectedAmount: z.number().int().positive().optional(),
});
export type ExpectPaymentRequest = z.infer<typeof ExpectPaymentRequestSchema>;

// POST /settlement/receipt — bank receipt captured; optional EOB.
export const RecordReceiptRequestSchema = z.object({
  receivedAmount: z.number().int().nonnegative(),
  receivedAt: z.string().datetime().optional(),
  eobDocumentId: z.string().uuid().optional(),
  shortPaymentReasons: z.array(z.string().max(200)).max(20).optional(),
});
export type RecordReceiptRequest = z.infer<typeof RecordReceiptRequestSchema>;

// POST /settlement/reconcile — flips status to auto_matched + transitions
// payment.reconciled. Deduction lines are optional structured detail.
export const ReconcileRequestSchema = z.object({
  deductions: z.array(DeductionLineSchema).max(100).optional(),
});
export type ReconcileRequest = z.infer<typeof ReconcileRequestSchema>;

// POST /settlement/write-off — terminal loss path.
export const WriteOffRequestSchema = z.object({
  reason: z.string().min(1).max(2000),
});
export type WriteOffRequest = z.infer<typeof WriteOffRequestSchema>;

export const SettlementResponseSchema = z.object({
  settlement: SettlementSchema,
  status: z.string(),
});
export type SettlementResponse = z.infer<typeof SettlementResponseSchema>;
