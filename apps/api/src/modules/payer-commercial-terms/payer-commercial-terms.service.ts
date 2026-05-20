// Per-payer commercial terms — the structured half of an MOU.
//
// One row per (tenantId, payerCode); upsert semantics so the admin
// form can save a partial draft and continue editing later. The
// readiness service consults `mandatoryComplete(row)` to decide
// whether the onboarding step has been satisfied for this payer.
//
// Mandatory three:
//   - copayPercent OR copayFlatPaise (0 is valid; both can co-exist)
//   - deductiblePaise (0 is valid)
// Plus at least one RoomCategoryPayerRate per active room category —
// that check lives in PayerOnboardingStatusService below because it
// joins across two tables.

import {
  type BankPaymentMode,
  type CopayAppliesTo,
  type CopayFlatMode,
  type DeductibleScope,
  type PayerCommercialTerms,
  type PayerCommercialTermsListItem,
  type PayerOnboardingStatus,
  type UpsertPayerCommercialTermsRequest,
} from '@claims/contracts';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class PayerCommercialTermsService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------

  async list(tenantId: string): Promise<PayerCommercialTermsListItem[]> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const rows = await tx.payerCommercialTerms.findMany({
        where: { tenantId },
        orderBy: { payerCode: 'asc' },
      });
      return rows.map((r) => withMandatoryFlag(toContract(r)));
    });
  }

  async getByPayerCode(
    tenantId: string,
    payerCode: string,
  ): Promise<PayerCommercialTerms | null> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const row = await tx.payerCommercialTerms.findFirst({
        where: { tenantId, payerCode },
      });
      return row ? toContract(row) : null;
    });
  }

  // ---------------------------------------------------------------
  // Writes — upsert by (tenantId, payerCode)
  // ---------------------------------------------------------------

  async upsert(
    tenantId: string,
    input: UpsertPayerCommercialTermsRequest,
  ): Promise<PayerCommercialTerms> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const existing = await tx.payerCommercialTerms.findFirst({
        where: { tenantId, payerCode: input.payerCode },
      });
      const fields = buildFields(input);
      const row = existing
        ? await tx.payerCommercialTerms.update({
            where: { id: existing.id },
            data: fields,
          })
        : await tx.payerCommercialTerms.create({
            data: {
              tenantId,
              payerCode: input.payerCode,
              // Falls back to "now" when the admin saves a partial
              // draft without typing effectiveFrom yet. fields may
              // also carry an explicit effectiveFrom which Prisma
              // accepts as override below.
              effectiveFrom: fields.effectiveFrom ?? new Date(),
              ...fields,
            },
          });
      return toContract(row);
    });
  }

  async deactivate(tenantId: string, payerCode: string): Promise<PayerCommercialTerms> {
    return this.upsert(tenantId, { payerCode, active: false });
  }

  // ---------------------------------------------------------------
  // Onboarding completeness — per-payer status across the catalog
  // ---------------------------------------------------------------

  // Returns one row per active Payer the tenant has marked relevant
  // (today = every Payer master row tagged active; tomorrow may
  // narrow once we model per-tenant payer empanelment). For each
  // payer we count room rate overrides set vs the count of active
  // room categories, and surface whether the mandatory terms are
  // filled. fullyComplete is the AND of the two.
  async listOnboardingStatus(tenantId: string): Promise<{
    payers: PayerOnboardingStatus[];
    allPayersComplete: boolean;
  }> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const [payers, categories, allTerms, allRates] = await Promise.all([
        tx.payer.findMany({
          where: { active: true },
          select: { code: true, name: true },
          orderBy: { name: 'asc' },
        }),
        tx.roomCategory.findMany({
          where: { tenantId, active: true },
          select: { id: true },
        }),
        tx.payerCommercialTerms.findMany({
          where: { tenantId, active: true },
        }),
        tx.roomCategoryPayerRate.findMany({
          where: {
            tenantId,
            active: true,
          },
          select: { payerCode: true, roomCategoryId: true },
        }),
      ]);
      const termsByPayer = new Map(allTerms.map((t) => [t.payerCode, t]));
      const ratesByPayer = new Map<string, Set<string>>();
      for (const r of allRates) {
        const set = ratesByPayer.get(r.payerCode) ?? new Set<string>();
        set.add(r.roomCategoryId);
        ratesByPayer.set(r.payerCode, set);
      }
      const totalActiveCategories = categories.length;

      const out: PayerOnboardingStatus[] = payers.map((p) => {
        const terms = termsByPayer.get(p.code) ?? null;
        const rates = ratesByPayer.get(p.code) ?? new Set<string>();
        const roomRatesFilled = rates.size;
        const termsMandatoryComplete = terms ? mandatoryComplete(terms) : false;
        const fullyComplete =
          termsMandatoryComplete &&
          totalActiveCategories > 0 &&
          roomRatesFilled >= totalActiveCategories;
        return {
          payerCode: p.code,
          payerName: p.name,
          roomRatesFilled,
          roomRatesTotal: totalActiveCategories,
          termsMandatoryComplete,
          fullyComplete,
        };
      });
      const allPayersComplete = out.length > 0 && out.every((r) => r.fullyComplete);
      return { payers: out, allPayersComplete };
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

// Mandatory check — operator must have set either co-pay channel and
// the deductible. Null means "not entered yet"; 0 is a valid value
// (no co-pay, no deductible).
function mandatoryComplete(row: {
  copayPercent: number | null;
  copayFlatPaise: number | null;
  deductiblePaise: number | null;
}): boolean {
  const copayPresent = row.copayPercent !== null || row.copayFlatPaise !== null;
  return copayPresent && row.deductiblePaise !== null;
}

function withMandatoryFlag(t: PayerCommercialTerms): PayerCommercialTermsListItem {
  return { ...t, mandatoryComplete: mandatoryComplete(t) };
}

// Build the Prisma update payload. Strips the natural-key field
// (payerCode is set by the caller, not mutated) and converts ISO
// datetime strings to Date objects. Optional `undefined` inputs are
// dropped so they don't overwrite stored values with null on partial
// updates — admins commonly save a partial draft and come back later.
//
// We type this as PayerCommercialTermsUpdateInput (vs CreateInput) so
// every field is optional — fits both the update path (used as-is)
// and the create path (spread alongside the natural-key fields).
// Partial<UncheckedCreateInput> lets us write raw scalar values for
// any field (which the create call needs) while keeping every field
// optional (which the update call needs). `UpdateInput` wraps scalars
// in { set: value } variants that don't survive a spread into create.
type CommercialTermsFields = Partial<Prisma.PayerCommercialTermsUncheckedCreateInput>;

function buildFields(input: UpsertPayerCommercialTermsRequest): CommercialTermsFields {
  const out: CommercialTermsFields = {};
  if (input.copayPercent !== undefined) out.copayPercent = input.copayPercent;
  if (input.copayFlatPaise !== undefined) out.copayFlatPaise = input.copayFlatPaise;
  if (input.copayFlatMode !== undefined) out.copayFlatMode = input.copayFlatMode;
  if (input.copayAppliesTo !== undefined) out.copayAppliesTo = input.copayAppliesTo;
  if (input.deductiblePaise !== undefined) out.deductiblePaise = input.deductiblePaise;
  if (input.deductibleScope !== undefined) out.deductibleScope = input.deductibleScope;

  if (input.effectiveFrom !== undefined) out.effectiveFrom = new Date(input.effectiveFrom);
  if (input.effectiveTo !== undefined) {
    out.effectiveTo = input.effectiveTo === null ? null : new Date(input.effectiveTo);
  }
  if (input.signedOn !== undefined) {
    out.signedOn = input.signedOn === null ? null : new Date(input.signedOn);
  }
  if (input.signatoryName !== undefined) out.signatoryName = input.signatoryName;
  if (input.noticePeriodDays !== undefined) out.noticePeriodDays = input.noticePeriodDays;
  if (input.autoRenews !== undefined) out.autoRenews = input.autoRenews;

  if (input.preauthTatMinutes !== undefined) out.preauthTatMinutes = input.preauthTatMinutes;
  if (input.claimTatMinutes !== undefined) out.claimTatMinutes = input.claimTatMinutes;
  if (input.priorIntimationRequired !== undefined)
    out.priorIntimationRequired = input.priorIntimationRequired;
  if (input.priorIntimationHours !== undefined)
    out.priorIntimationHours = input.priorIntimationHours;

  if (input.flatDiscountPercent !== undefined)
    out.flatDiscountPercent = input.flatDiscountPercent;
  if (input.pharmacyDiscountPercent !== undefined)
    out.pharmacyDiscountPercent = input.pharmacyDiscountPercent;
  if (input.implantPassThrough !== undefined)
    out.implantPassThrough = input.implantPassThrough;
  if (input.implantMarkupCapPercent !== undefined)
    out.implantMarkupCapPercent = input.implantMarkupCapPercent;

  if (input.roomRentCapPaisePerDay !== undefined)
    out.roomRentCapPaisePerDay = input.roomRentCapPaisePerDay;
  if (input.icuCapPaisePerDay !== undefined) out.icuCapPaisePerDay = input.icuCapPaisePerDay;
  if (input.nursingCapPaisePerDay !== undefined)
    out.nursingCapPaisePerDay = input.nursingCapPaisePerDay;

  if (input.consultationCapPaise !== undefined)
    out.consultationCapPaise = input.consultationCapPaise;
  if (input.ambulanceCapPaise !== undefined) out.ambulanceCapPaise = input.ambulanceCapPaise;

  if (input.preExistingWaitingMonths !== undefined)
    out.preExistingWaitingMonths = input.preExistingWaitingMonths;
  if (input.maternityCovered !== undefined) out.maternityCovered = input.maternityCovered;
  if (input.maternityWaitingMonths !== undefined)
    out.maternityWaitingMonths = input.maternityWaitingMonths;
  if (input.dayCareProceduresCovered !== undefined)
    out.dayCareProceduresCovered = input.dayCareProceduresCovered;
  if (input.modernTreatmentsCovered !== undefined)
    out.modernTreatmentsCovered = input.modernTreatmentsCovered;

  if (input.paymentTermDays !== undefined) out.paymentTermDays = input.paymentTermDays;
  if (input.paymentMode !== undefined) out.paymentMode = input.paymentMode;
  if (input.bankAccountRef !== undefined) out.bankAccountRef = input.bankAccountRef;
  if (input.tdsPercent !== undefined) out.tdsPercent = input.tdsPercent;
  if (input.interestOnDelayedPercent !== undefined)
    out.interestOnDelayedPercent = input.interestOnDelayedPercent;
  if (input.disputeEscalationDays !== undefined)
    out.disputeEscalationDays = input.disputeEscalationDays;

  if (input.networkCategory !== undefined) out.networkCategory = input.networkCategory;
  if (input.nabhRequired !== undefined) out.nabhRequired = input.nabhRequired;
  if (input.nablRequired !== undefined) out.nablRequired = input.nablRequired;
  if (input.empanelledSpecialties !== undefined)
    out.empanelledSpecialties = input.empanelledSpecialties;

  if (input.notes !== undefined) out.notes = input.notes;
  if (input.active !== undefined) out.active = input.active;
  return out;
}

// Prisma → contract projection.
function toContract(row: PrismaPayerCommercialTermsRow): PayerCommercialTerms {
  return {
    id: row.id,
    payerCode: row.payerCode,
    copayPercent: row.copayPercent,
    copayFlatPaise: row.copayFlatPaise,
    copayFlatMode: row.copayFlatMode as CopayFlatMode | null,
    copayAppliesTo: row.copayAppliesTo as CopayAppliesTo | null,
    deductiblePaise: row.deductiblePaise,
    deductibleScope: row.deductibleScope as DeductibleScope | null,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo ? row.effectiveTo.toISOString() : null,
    signedOn: row.signedOn ? row.signedOn.toISOString() : null,
    signatoryName: row.signatoryName,
    noticePeriodDays: row.noticePeriodDays,
    autoRenews: row.autoRenews,
    preauthTatMinutes: row.preauthTatMinutes,
    claimTatMinutes: row.claimTatMinutes,
    priorIntimationRequired: row.priorIntimationRequired,
    priorIntimationHours: row.priorIntimationHours,
    flatDiscountPercent: row.flatDiscountPercent,
    pharmacyDiscountPercent: row.pharmacyDiscountPercent,
    implantPassThrough: row.implantPassThrough,
    implantMarkupCapPercent: row.implantMarkupCapPercent,
    roomRentCapPaisePerDay: row.roomRentCapPaisePerDay,
    icuCapPaisePerDay: row.icuCapPaisePerDay,
    nursingCapPaisePerDay: row.nursingCapPaisePerDay,
    consultationCapPaise: row.consultationCapPaise,
    ambulanceCapPaise: row.ambulanceCapPaise,
    preExistingWaitingMonths: row.preExistingWaitingMonths,
    maternityCovered: row.maternityCovered,
    maternityWaitingMonths: row.maternityWaitingMonths,
    dayCareProceduresCovered: row.dayCareProceduresCovered,
    modernTreatmentsCovered: row.modernTreatmentsCovered,
    paymentTermDays: row.paymentTermDays,
    paymentMode: row.paymentMode as BankPaymentMode | null,
    bankAccountRef: row.bankAccountRef,
    tdsPercent: row.tdsPercent,
    interestOnDelayedPercent: row.interestOnDelayedPercent,
    disputeEscalationDays: row.disputeEscalationDays,
    networkCategory: row.networkCategory,
    nabhRequired: row.nabhRequired,
    nablRequired: row.nablRequired,
    empanelledSpecialties: row.empanelledSpecialties,
    notes: row.notes,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Row shape mirror — used so the projection compiles without
// referencing Prisma types directly.
interface PrismaPayerCommercialTermsRow {
  id: string;
  payerCode: string;
  copayPercent: number | null;
  copayFlatPaise: number | null;
  copayFlatMode: string | null;
  copayAppliesTo: string | null;
  deductiblePaise: number | null;
  deductibleScope: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  signedOn: Date | null;
  signatoryName: string | null;
  noticePeriodDays: number | null;
  autoRenews: boolean;
  preauthTatMinutes: number | null;
  claimTatMinutes: number | null;
  priorIntimationRequired: boolean;
  priorIntimationHours: number | null;
  flatDiscountPercent: number | null;
  pharmacyDiscountPercent: number | null;
  implantPassThrough: boolean;
  implantMarkupCapPercent: number | null;
  roomRentCapPaisePerDay: number | null;
  icuCapPaisePerDay: number | null;
  nursingCapPaisePerDay: number | null;
  consultationCapPaise: number | null;
  ambulanceCapPaise: number | null;
  preExistingWaitingMonths: number | null;
  maternityCovered: boolean;
  maternityWaitingMonths: number | null;
  dayCareProceduresCovered: boolean;
  modernTreatmentsCovered: boolean;
  paymentTermDays: number | null;
  paymentMode: string | null;
  bankAccountRef: string | null;
  tdsPercent: number | null;
  interestOnDelayedPercent: number | null;
  disputeEscalationDays: number | null;
  networkCategory: string | null;
  nabhRequired: boolean;
  nablRequired: boolean;
  empanelledSpecialties: string[];
  notes: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}
