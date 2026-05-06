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

// Slice AL — payer remittance batch. Operators receive a remittance
// file (CSV / Excel) from the payer with one row per paid claim;
// rather than calling /settlement/receipt N times, they POST a batch
// here and get back per-row status. Matching is by claim.claimRefNum
// (set at claim submit time). Rows that don't match an open
// settlement are returned in `unmatched` so ops can handle them
// manually — we don't auto-create settlements just because a remittance
// row showed up.

export const RemittanceRowSchema = z.object({
  // The payer's reference for the claim — matches Claim.claimRefNum.
  claimRefNum: z.string().min(1).max(128),
  receivedAmount: z.number().int().nonnegative(),
  receivedAt: z.string().datetime().optional(),
  // Bank transaction id from the remittance file. Captured for
  // audit; not currently persisted on Settlement (that's a Sprint 5
  // hardening item — needs a schema change). Logged at the moment.
  bankTxnId: z.string().max(128).optional(),
  // When the remittance shows the payer recognising less than expected,
  // the operator typically annotates with the rejection codes the
  // payer sent. Free-form because formats vary across TPAs.
  shortPaymentReasons: z.array(z.string().max(200)).max(20).optional(),
});
export type RemittanceRow = z.infer<typeof RemittanceRowSchema>;

export const RemittanceBatchRequestSchema = z.object({
  rows: z.array(RemittanceRowSchema).min(1).max(1000),
});
export type RemittanceBatchRequest = z.infer<typeof RemittanceBatchRequestSchema>;

export const RemittanceMatchOutcomeSchema = z.enum([
  'applied',
  'unmatched_no_claim',
  'unmatched_no_settlement',
  'failed',
]);
export type RemittanceMatchOutcome = z.infer<typeof RemittanceMatchOutcomeSchema>;

export const RemittanceRowResultSchema = z.object({
  claimRefNum: z.string(),
  outcome: RemittanceMatchOutcomeSchema,
  // Set when outcome === 'applied'. The settlement's reconciliation
  // status after recording the receipt — caller can spot which rows
  // landed as short_paid vs manual_match_pending.
  reconciliationStatus: z.string().optional(),
  // Set on outcome === 'failed' so callers can show a per-row error.
  error: z.string().optional(),
});
export type RemittanceRowResult = z.infer<typeof RemittanceRowResultSchema>;

export const RemittanceBatchResponseSchema = z.object({
  totalRows: z.number().int().nonnegative(),
  appliedCount: z.number().int().nonnegative(),
  unmatchedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  results: z.array(RemittanceRowResultSchema),
});
export type RemittanceBatchResponse = z.infer<typeof RemittanceBatchResponseSchema>;
