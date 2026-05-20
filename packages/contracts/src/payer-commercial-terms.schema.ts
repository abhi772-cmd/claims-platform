import { z } from 'zod';

// Per-payer commercial terms captured at onboarding (the structured
// half of an MOU). One row per (tenantId, payerCode).
//
// Mandatory for LIVE-state transition:
//   - copayPercent OR copayFlatPaise must be present (0 is valid)
//   - deductiblePaise must be present (0 is valid)
//   - At least one RoomCategoryPayerRate per active room category
//     (enforced by the onboarding readiness service, not this schema)
// Everything else is optional but recommended; the UI surfaces a
// completeness meter without blocking the LIVE transition.

const PAISE_MAX = 1_000_00_00_000; // ₹1 cr ceiling on per-line monetary fields
const PERCENT = z.number().int().min(0).max(100);

// Bank-level payment instrument (RTGS / NEFT / cheque / mixed) — the
// MOU says how the payer typically settles. Distinct from
// settlement.schema's PaymentMode which classifies the claim-level
// settlement route (cashless TPA / patient OOP / reimbursement /
// PMJAY disbursement).
export const BankPaymentModeSchema = z.enum(['rtgs', 'neft', 'cheque', 'mixed']);
export type BankPaymentMode = z.infer<typeof BankPaymentModeSchema>;

export const CopayAppliesToSchema = z.enum(['planned', 'emergency', 'both']);
export type CopayAppliesTo = z.infer<typeof CopayAppliesToSchema>;

export const DeductibleScopeSchema = z.enum([
  'per_admission',
  'per_claim',
  'per_year',
]);
export type DeductibleScope = z.infer<typeof DeductibleScopeSchema>;

// ─── Full row ─────────────────────────────────────────────────────

export const PayerCommercialTermsSchema = z.object({
  id: z.string().uuid(),
  payerCode: z.string().min(1).max(64),

  // Required-for-completion (nullable here because draft rows may not
  // have them yet; readiness service checks they're non-null).
  copayPercent: PERCENT.nullable(),
  copayFlatPaise: z.number().int().nonnegative().max(PAISE_MAX).nullable(),
  copayAppliesTo: CopayAppliesToSchema.nullable(),
  deductiblePaise: z.number().int().nonnegative().max(PAISE_MAX).nullable(),
  deductibleScope: DeductibleScopeSchema.nullable(),

  // Validity & lifecycle
  effectiveFrom: z.string().datetime(),
  effectiveTo: z.string().datetime().nullable(),
  signedOn: z.string().datetime().nullable(),
  signatoryName: z.string().nullable(),
  noticePeriodDays: z.number().int().nonnegative().nullable(),
  autoRenews: z.boolean(),

  // Operational TATs
  preauthTatMinutes: z.number().int().positive().nullable(),
  claimTatMinutes: z.number().int().positive().nullable(),
  priorIntimationRequired: z.boolean(),
  priorIntimationHours: z.number().int().nonnegative().nullable(),

  // Tariff modifiers
  flatDiscountPercent: PERCENT.nullable(),
  pharmacyDiscountPercent: PERCENT.nullable(),
  implantPassThrough: z.boolean(),
  implantMarkupCapPercent: PERCENT.nullable(),

  // Per-day sub-limits
  roomRentCapPaisePerDay: z.number().int().nonnegative().max(PAISE_MAX).nullable(),
  icuCapPaisePerDay: z.number().int().nonnegative().max(PAISE_MAX).nullable(),
  nursingCapPaisePerDay: z.number().int().nonnegative().max(PAISE_MAX).nullable(),

  // Per-claim sub-limits
  consultationCapPaise: z.number().int().nonnegative().max(PAISE_MAX).nullable(),
  ambulanceCapPaise: z.number().int().nonnegative().max(PAISE_MAX).nullable(),

  // Coverage rules
  preExistingWaitingMonths: z.number().int().nonnegative().nullable(),
  maternityCovered: z.boolean(),
  maternityWaitingMonths: z.number().int().nonnegative().nullable(),
  dayCareProceduresCovered: z.boolean(),
  modernTreatmentsCovered: z.boolean(),

  // Settlement
  paymentTermDays: z.number().int().nonnegative().nullable(),
  paymentMode: BankPaymentModeSchema.nullable(),
  bankAccountRef: z.string().nullable(),
  tdsPercent: PERCENT.nullable(),
  interestOnDelayedPercent: PERCENT.nullable(),
  disputeEscalationDays: z.number().int().nonnegative().nullable(),

  // Network / compliance
  networkCategory: z.string().nullable(),
  nabhRequired: z.boolean(),
  nablRequired: z.boolean(),
  empanelledSpecialties: z.array(z.string().min(1).max(120)),

  // Metadata
  notes: z.string().nullable(),
  active: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PayerCommercialTerms = z.infer<typeof PayerCommercialTermsSchema>;

// ─── Upsert request ───────────────────────────────────────────────
// One body shape covers create + update — the (tenantId, payerCode)
// natural key makes the operation idempotent. Every field is
// optional in the input; server merges with existing or applies
// schema defaults for booleans.

export const UpsertPayerCommercialTermsRequestSchema = z
  .object({
    payerCode: z.string().min(1).max(64),

    copayPercent: PERCENT.nullable().optional(),
    copayFlatPaise: z.number().int().nonnegative().max(PAISE_MAX).nullable().optional(),
    copayAppliesTo: CopayAppliesToSchema.nullable().optional(),
    deductiblePaise: z.number().int().nonnegative().max(PAISE_MAX).nullable().optional(),
    deductibleScope: DeductibleScopeSchema.nullable().optional(),

    effectiveFrom: z.string().datetime().optional(),
    effectiveTo: z.string().datetime().nullable().optional(),
    signedOn: z.string().datetime().nullable().optional(),
    signatoryName: z.string().max(200).nullable().optional(),
    noticePeriodDays: z.number().int().nonnegative().nullable().optional(),
    autoRenews: z.boolean().optional(),

    preauthTatMinutes: z.number().int().positive().nullable().optional(),
    claimTatMinutes: z.number().int().positive().nullable().optional(),
    priorIntimationRequired: z.boolean().optional(),
    priorIntimationHours: z.number().int().nonnegative().nullable().optional(),

    flatDiscountPercent: PERCENT.nullable().optional(),
    pharmacyDiscountPercent: PERCENT.nullable().optional(),
    implantPassThrough: z.boolean().optional(),
    implantMarkupCapPercent: PERCENT.nullable().optional(),

    roomRentCapPaisePerDay: z.number().int().nonnegative().max(PAISE_MAX).nullable().optional(),
    icuCapPaisePerDay: z.number().int().nonnegative().max(PAISE_MAX).nullable().optional(),
    nursingCapPaisePerDay: z.number().int().nonnegative().max(PAISE_MAX).nullable().optional(),

    consultationCapPaise: z.number().int().nonnegative().max(PAISE_MAX).nullable().optional(),
    ambulanceCapPaise: z.number().int().nonnegative().max(PAISE_MAX).nullable().optional(),

    preExistingWaitingMonths: z.number().int().nonnegative().nullable().optional(),
    maternityCovered: z.boolean().optional(),
    maternityWaitingMonths: z.number().int().nonnegative().nullable().optional(),
    dayCareProceduresCovered: z.boolean().optional(),
    modernTreatmentsCovered: z.boolean().optional(),

    paymentTermDays: z.number().int().nonnegative().nullable().optional(),
    paymentMode: BankPaymentModeSchema.nullable().optional(),
    bankAccountRef: z.string().max(500).nullable().optional(),
    tdsPercent: PERCENT.nullable().optional(),
    interestOnDelayedPercent: PERCENT.nullable().optional(),
    disputeEscalationDays: z.number().int().nonnegative().nullable().optional(),

    networkCategory: z.string().max(120).nullable().optional(),
    nabhRequired: z.boolean().optional(),
    nablRequired: z.boolean().optional(),
    empanelledSpecialties: z.array(z.string().min(1).max(120)).optional(),

    notes: z.string().max(2000).nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine(
    (val) =>
      val.effectiveTo === undefined ||
      val.effectiveTo === null ||
      val.effectiveFrom === undefined ||
      new Date(val.effectiveTo) > new Date(val.effectiveFrom),
    {
      message: 'effectiveTo must be after effectiveFrom',
      path: ['effectiveTo'],
    },
  );
export type UpsertPayerCommercialTermsRequest = z.infer<
  typeof UpsertPayerCommercialTermsRequestSchema
>;

// ─── List response ────────────────────────────────────────────────

// Used by the onboarding step page. Row carries a completeness flag
// the admin UI uses to render the per-payer status dot without
// re-deriving the check on the client.
export const PayerCommercialTermsListItemSchema = PayerCommercialTermsSchema.extend({
  // True when the mandatory three (one of copayPercent/copayFlat, plus
  // deductiblePaise) are filled. Room-rate completeness is a separate
  // check the readiness service does against RoomCategoryPayerRate.
  mandatoryComplete: z.boolean(),
});
export type PayerCommercialTermsListItem = z.infer<
  typeof PayerCommercialTermsListItemSchema
>;

export const PayerCommercialTermsListResponseSchema = z.object({
  terms: z.array(PayerCommercialTermsListItemSchema),
});
export type PayerCommercialTermsListResponse = z.infer<
  typeof PayerCommercialTermsListResponseSchema
>;

// ─── Onboarding completeness summary ──────────────────────────────
// Returned by the onboarding step page so the UI can render the
// per-payer status table in one fetch.

export const PayerOnboardingStatusSchema = z.object({
  payerCode: z.string(),
  payerName: z.string(),
  // Number of room rate overrides filled / total active categories.
  roomRatesFilled: z.number().int().nonnegative(),
  roomRatesTotal: z.number().int().nonnegative(),
  // True when this payer has a PayerCommercialTerms row with the
  // mandatory three filled.
  termsMandatoryComplete: z.boolean(),
  // True when room rates AND terms mandatory are both complete.
  fullyComplete: z.boolean(),
});
export type PayerOnboardingStatus = z.infer<typeof PayerOnboardingStatusSchema>;

export const PayerOnboardingStatusResponseSchema = z.object({
  payers: z.array(PayerOnboardingStatusSchema),
  // Convenience flag for the step-complete CTA on the UI.
  allPayersComplete: z.boolean(),
});
export type PayerOnboardingStatusResponse = z.infer<
  typeof PayerOnboardingStatusResponseSchema
>;
