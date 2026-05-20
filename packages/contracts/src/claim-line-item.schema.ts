import { z } from 'zod';

import { PayerRailSchema } from './master-data.schema';

// D-023 — the costing spine of a claim. For PMJAY each `package` line
// is an HBP package at its fixed rate; `implant`/`addon` lines carry
// the rest. Claim.preauthAmount / claimAmount / approvedAmount are
// materialised SUMS over these rows.
//
// Phase 1 writes a single `package` line server-side from the operator's
// package selection (see preauth save path). Multi-line authoring from
// the UI is Phase 3; the request schemas below already accept an array
// so that phase is frontend-only.

export const ClaimLineTypeSchema = z.enum(['package', 'implant', 'addon']);
export type ClaimLineType = z.infer<typeof ClaimLineTypeSchema>;

export const ClaimLineStatusSchema = z.enum([
  'requested',
  'approved',
  'rejected',
  'partial',
]);
export type ClaimLineStatus = z.infer<typeof ClaimLineStatusSchema>;

// ₹50 lakh ceiling per line — same sanity bound as bill line items.
const AMOUNT_CEILING_PAISE = 50_00_00_000;

export const ClaimLineItemSchema = z.object({
  id: z.string().uuid(),
  lineType: ClaimLineTypeSchema,
  // HBP package code for pmjay package lines; internal code otherwise.
  code: z.string(),
  // Human-readable name, snapshotted at add-time.
  display: z.string(),
  rail: PayerRailSchema,
  // Paise. For a package line = the HBP fixed rate at add-time.
  unitAmount: z.number().int().nonnegative(),
  quantity: z.number().int().positive(),
  // Paise. Defaults to unitAmount * quantity; overridable.
  requestedAmount: z.number().int().nonnegative(),
  // Paise, nullable — set from the payer's per-line adjudication.
  approvedAmount: z.number().int().nonnegative().nullable(),
  lineStatus: ClaimLineStatusSchema,
  // 1-based; maps to FHIR Claim.item[].sequence.
  sequence: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ClaimLineItem = z.infer<typeof ClaimLineItemSchema>;

// One row in an authoring payload — the persisted shape minus the
// server-assigned fields. `requestedAmount` is optional: when omitted
// the server fills it from unitAmount * quantity (D-023 auto-fill).
export const SaveClaimLineItemSchema = z.object({
  lineType: ClaimLineTypeSchema,
  code: z.string().min(1).max(64),
  display: z.string().min(1).max(300),
  unitAmount: z.number().int().nonnegative().max(AMOUNT_CEILING_PAISE),
  quantity: z.number().int().positive().max(999).optional(),
  requestedAmount: z
    .number()
    .int()
    .nonnegative()
    .max(AMOUNT_CEILING_PAISE)
    .optional(),
});
export type SaveClaimLineItem = z.infer<typeof SaveClaimLineItemSchema>;

export const SaveClaimLineItemsRequestSchema = z.object({
  // 0..50 — 0 clears the set; 50 is a sanity ceiling (a single
  // admission never legitimately claims dozens of packages).
  lines: z.array(SaveClaimLineItemSchema).max(50),
});
export type SaveClaimLineItemsRequest = z.infer<
  typeof SaveClaimLineItemsRequestSchema
>;

export const ClaimLineItemsListResponseSchema = z.object({
  lines: z.array(ClaimLineItemSchema),
  // Server-computed total of requestedAmount across the lines so the
  // UI can show the headline without re-summing.
  totalRequestedPaise: z.number().int().nonnegative(),
});
export type ClaimLineItemsListResponse = z.infer<
  typeof ClaimLineItemsListResponseSchema
>;
