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
  bankTxnId: z.string().nullable(),
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
  bankTxnId: z.string().max(128).optional(),
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
  // Bank transaction id from the remittance file. Persisted on the
  // matched Settlement so finance can reconcile a settlement back to
  // the originating bank line item.
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

// ============================================================
// T3-2 — lump-sum UTR allocation
// ============================================================
// Slice AL (above) handles the "payer sent us a remittance file
// with per-claim breakdown" case. T3-2 is the inverse case:
//
//   Bank shows ONE deposit of ₹3,00,000 with UTR 'HDFC0123' against
//   a TPA payer. There is NO per-claim breakdown — the operator has
//   to figure out which open settlements the lump matches and
//   allocate the amount across them manually.
//
// Flow:
//   1. Operator hits GET /settlement/remittance/candidates with
//      payerCode + totalAmount → service returns open settlements
//      for that payer with their expectedAmount and current
//      receivedAmount. UI ranks them so the operator can pick.
//   2. Operator picks N settlements + assigns per-claim amounts
//      that sum to the UTR total.
//   3. POST /settlement/remittance/lump-sum applies all allocations
//      atomically. Each per-claim leg goes through the same
//      SettlementService.recordReceipt path as the manual flow, so
//      state-machine semantics + audit + reconciliationStatus all
//      stay identical to per-claim. The shared bankTxnId on every
//      Settlement row ties the lump back together for finance audit.
//
// We deliberately do NOT add a RemittanceBatch table — the
// Settlement.bankTxnId column + per-claim claim_event rows already
// give a complete audit trail. Adding a separate table would
// duplicate state without earning anything.

export const RemittanceCandidateSchema = z.object({
  claimId: z.string().uuid(),
  claimRefNum: z.string().nullable(),
  patientName: z.string(),
  payerCode: z.string().nullable(),
  expectedAmount: z.number().int().nonnegative(),
  // Already-received amount (null when no receipt recorded yet).
  // Used by the UI to show "₹X of ₹Y received" + suggest the
  // remaining (expectedAmount - currentReceivedAmount) as the
  // default per-claim allocation.
  currentReceivedAmount: z.number().int().nonnegative().nullable(),
  reconciliationStatus: z.string(),
});
export type RemittanceCandidate = z.infer<typeof RemittanceCandidateSchema>;

export const RemittanceCandidatesResponseSchema = z.object({
  candidates: z.array(RemittanceCandidateSchema),
});
export type RemittanceCandidatesResponse = z.infer<typeof RemittanceCandidatesResponseSchema>;

export const LumpSumAllocationSchema = z.object({
  claimId: z.string().uuid(),
  // Per-claim allocated amount in paise. Allowed to be less than the
  // settlement's expectedAmount — that's exactly the "short payment"
  // case the existing recordReceipt path handles.
  allocatedAmount: z.number().int().nonnegative(),
});
export type LumpSumAllocation = z.infer<typeof LumpSumAllocationSchema>;

export const LumpSumAllocateRequestSchema = z.object({
  // Bank transaction id (UTR, NEFT ref, RTGS ref, etc.). Persisted
  // on every per-claim Settlement row so finance can reverse-lookup
  // which claims a single deposit covered.
  bankTxnId: z.string().min(1).max(128),
  // The total received from the bank. Sum of allocations must equal
  // this — service rejects with REMITTANCE_ALLOCATION_VARIANCE
  // otherwise.
  totalAmount: z.number().int().positive(),
  receivedAt: z.string().datetime().optional(),
  // Optional. Used only for the duplicate-UTR check + audit trail.
  payerCode: z.string().min(1).max(128).optional(),
  allocations: z
    .array(LumpSumAllocationSchema)
    .min(1, 'At least one allocation is required.')
    .max(200, 'Cannot allocate to more than 200 claims in a single batch.'),
});
export type LumpSumAllocateRequest = z.infer<typeof LumpSumAllocateRequestSchema>;

export const LumpSumAllocateResultSchema = z.object({
  claimId: z.string().uuid(),
  allocatedAmount: z.number().int().nonnegative(),
  outcome: z.enum(['applied', 'failed']),
  reconciliationStatus: z.string().optional(),
  error: z.string().optional(),
});
export type LumpSumAllocateResult = z.infer<typeof LumpSumAllocateResultSchema>;

export const LumpSumAllocateResponseSchema = z.object({
  bankTxnId: z.string(),
  totalAmount: z.number().int().positive(),
  allocatedTotal: z.number().int().nonnegative(),
  // applied count + failed count; failed allocations DO NOT roll
  // back the applied ones (matches Slice AL semantics). Operator
  // re-runs the failed legs.
  appliedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  results: z.array(LumpSumAllocateResultSchema),
});
export type LumpSumAllocateResponse = z.infer<typeof LumpSumAllocateResponseSchema>;
