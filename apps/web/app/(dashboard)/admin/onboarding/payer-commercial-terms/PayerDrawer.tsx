'use client';

// Slide-over drawer for editing one payer's commercial terms.
// Three tabs: Tariff (mandatory — room rates + co-pay + deductible),
// Operations & settlement (TAT, payment, sub-limits, discounts),
// Coverage & compliance (waiting periods, network, flags, specialties).
//
// Saves in two passes: room rate upserts via RoomCategoryApi, then a
// single upsert against PayerCommercialTermsApi. The two halves are
// independent — if the rates save succeeds but the terms save fails,
// the rates stay and the operator retries. The page-level refresh()
// pulls fresh status either way.

import {
  type BankPaymentMode,
  type CopayAppliesTo,
  type DeductibleScope,
  type PayerCommercialTerms,
  type RoomCategory,
  type RoomCategoryPayerRate,
  type UpsertPayerCommercialTermsRequest,
} from '@claims/contracts';
import { useCallback, useEffect, useState } from 'react';

import { RoomRateMatrix } from './RoomRateMatrix';
import { useErrorModal } from '../../../../../components/modals/ErrorModal/ErrorModalProvider';
import { PayerCommercialTermsApi } from '../../../../../lib/api/payer-commercial-terms.api';
import { RoomCategoryApi } from '../../../../../lib/api/room-category.api';

type Tab = 'tariff' | 'operations' | 'coverage';

interface Props {
  payerCode: string;
  payerName: string;
  categories: RoomCategory[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}

export function PayerDrawer({
  payerCode,
  payerName,
  categories,
  onClose,
  onSaved,
}: Props): JSX.Element {
  const { showApiError } = useErrorModal();
  const [tab, setTab] = useState<Tab>('tariff');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [terms, setTerms] = useState<PayerCommercialTerms | null>(null);

  // Room rate matrix state — one entry per category. Empty string
  // means "no override" (delete the row on save when it had one).
  const [rates, setRates] = useState<Record<string, string>>({});
  const [existingRateIds, setExistingRateIds] = useState<Record<string, RoomCategoryPayerRate>>({});

  // Terms form state. Initialised from terms on load; null-tolerant
  // strings so the operator can leave a field blank → null.
  const [form, setForm] = useState<TermsFormState>(emptyTermsForm());

  // Initial load: try to fetch existing terms (404 if none) and the
  // existing rate overrides for every category in parallel.
  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const [existingTerms, ratesByCategory] = await Promise.all([
          // get() throws 404 when no row — swallow that one specific
          // failure since "no terms yet" is the common pre-fill case.
          PayerCommercialTermsApi.get(payerCode).catch((err: unknown) => {
            if (err instanceof Error && /404|not found/i.test(err.message)) {
              return null;
            }
            throw err;
          }),
          Promise.all(
            categories.map(async (c) => {
              const res = await RoomCategoryApi.listPayerRates(c.id);
              return { categoryId: c.id, rates: res.rates };
            }),
          ),
        ]);
        if (cancelled) return;
        if (existingTerms) {
          setTerms(existingTerms);
          setForm(formFromTerms(existingTerms));
        }
        // Pre-fill rate inputs from existing overrides for THIS payer.
        const nextRates: Record<string, string> = {};
        const nextIds: Record<string, RoomCategoryPayerRate> = {};
        for (const { categoryId, rates: list } of ratesByCategory) {
          const mine = list.find((r) => r.payerCode === payerCode);
          if (mine) {
            nextRates[categoryId] = paiseToRupeesStr(mine.dailyRatePaise);
            nextIds[categoryId] = mine;
          }
        }
        setRates(nextRates);
        setExistingRateIds(nextIds);
      } catch (err) {
        if (!cancelled) showApiError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [categories, payerCode, showApiError]);

  const onSave = useCallback(async (): Promise<void> => {
    setSaving(true);
    try {
      // ── Pass 1: persist the rate matrix. Upsert filled cells;
      //    delete entries the operator cleared.
      for (const c of categories) {
        const raw = (rates[c.id] ?? '').trim();
        const had = existingRateIds[c.id];
        if (raw.length === 0) {
          if (had) {
            await RoomCategoryApi.deletePayerRate(c.id, payerCode);
          }
          continue;
        }
        const paise = Math.round(Number(raw) * 100);
        if (!Number.isFinite(paise) || paise < 0) continue;
        await RoomCategoryApi.upsertPayerRate(c.id, {
          payerCode,
          dailyRatePaise: paise,
        });
      }

      // ── Pass 2: persist commercial terms. UpsertPayerCommercialTermsRequest
      //    accepts every field optional; we send what the form has.
      const body = buildUpsertBody(payerCode, form);
      await PayerCommercialTermsApi.upsert(body);

      await onSaved();
      onClose();
    } catch (err) {
      showApiError(err);
    } finally {
      setSaving(false);
    }
  }, [
    categories,
    existingRateIds,
    form,
    onClose,
    onSaved,
    payerCode,
    rates,
    showApiError,
  ]);

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Overlay */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-on-surface/40 backdrop-blur-sm"
      />

      {/* Slide-over panel */}
      <aside className="relative ml-auto flex h-full w-full max-w-[840px] flex-col bg-surface shadow-2xl">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-outline-variant/40 bg-surface-container-lowest/80 px-6 py-4">
          <div>
            <div className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
              Commercial terms
            </div>
            <h3 className="mt-0.5 text-h3 font-h3 text-on-surface">{payerName}</h3>
            <div className="font-mono text-[12px] text-on-surface-variant">
              {payerCode}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-on-surface-variant transition-colors hover:bg-on-surface/5"
            aria-label="Close drawer"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </header>

        {/* Tabs */}
        <nav className="flex border-b border-outline-variant/40 bg-surface-container-lowest/40 px-6">
          <TabButton
            label="Tariff"
            badge="Required"
            active={tab === 'tariff'}
            onClick={() => setTab('tariff')}
          />
          <TabButton
            label="Operations & settlement"
            active={tab === 'operations'}
            onClick={() => setTab('operations')}
          />
          <TabButton
            label="Coverage & compliance"
            active={tab === 'coverage'}
            onClick={() => setTab('coverage')}
          />
        </nav>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="text-body text-on-surface-variant">Loading…</div>
          ) : tab === 'tariff' ? (
            <TariffTab
              categories={categories}
              rates={rates}
              setRates={setRates}
              form={form}
              setForm={setForm}
            />
          ) : tab === 'operations' ? (
            <OperationsTab form={form} setForm={setForm} />
          ) : (
            <CoverageTab form={form} setForm={setForm} />
          )}
        </div>

        {/* Footer */}
        <footer className="flex items-center justify-between border-t border-outline-variant/40 bg-surface-container-lowest/80 px-6 py-4">
          <span className="text-body-sm text-on-surface-variant">
            {terms
              ? `Last saved ${new Date(terms.updatedAt).toLocaleString('en-IN')}`
              : 'New terms — no record yet'}
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-outline-variant px-5 py-2 text-body-sm text-on-surface transition-colors hover:bg-on-surface/5"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void onSave()}
              disabled={saving}
              className="btn-cta disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </footer>
      </aside>
    </div>
  );
}

// =============================================================================
// Tabs
// =============================================================================

function TariffTab({
  categories,
  rates,
  setRates,
  form,
  setForm,
}: {
  categories: RoomCategory[];
  rates: Record<string, string>;
  setRates: (next: Record<string, string>) => void;
  form: TermsFormState;
  setForm: (next: TermsFormState) => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SectionHeading
        icon="bed"
        title="Room rate matrix"
        subtitle="Negotiated daily rate for each room category. Leave blank to fall back to the catalog default."
      />
      <RoomRateMatrix categories={categories} rates={rates} onChange={setRates} />

      <SectionHeading
        icon="payments"
        title="Co-pay (mandatory)"
        subtitle="Set the percent OR flat rupee amount the patient covers. Both can co-exist (e.g. '10% capped at ₹50k')."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <NumberField
          label="Co-pay %"
          value={form.copayPercent}
          onChange={(v) => setForm({ ...form, copayPercent: v })}
          placeholder="e.g. 10"
        />
        <NumberField
          label="Co-pay flat (₹)"
          value={form.copayFlatRupees}
          onChange={(v) => setForm({ ...form, copayFlatRupees: v })}
          placeholder="e.g. 5000"
        />
        <SelectField
          label="Applies to"
          value={form.copayAppliesTo}
          onChange={(v) => setForm({ ...form, copayAppliesTo: v as CopayAppliesTo | '' })}
          options={[
            { value: '', label: '— select —' },
            { value: 'planned', label: 'Planned only' },
            { value: 'emergency', label: 'Emergency only' },
            { value: 'both', label: 'Both' },
          ]}
        />
      </div>

      <SectionHeading
        icon="account_balance_wallet"
        title="Deductible (mandatory)"
        subtitle="Amount the patient covers before the payer kicks in. Zero is a valid value."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <NumberField
          label="Deductible (₹)"
          value={form.deductibleRupees}
          onChange={(v) => setForm({ ...form, deductibleRupees: v })}
          placeholder="e.g. 5000"
        />
        <SelectField
          label="Scope"
          value={form.deductibleScope}
          onChange={(v) =>
            setForm({ ...form, deductibleScope: v as DeductibleScope | '' })
          }
          options={[
            { value: '', label: '— select —' },
            { value: 'per_admission', label: 'Per admission' },
            { value: 'per_claim', label: 'Per claim' },
            { value: 'per_year', label: 'Per year' },
          ]}
        />
      </div>
    </div>
  );
}

function OperationsTab({
  form,
  setForm,
}: {
  form: TermsFormState;
  setForm: (next: TermsFormState) => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SectionHeading
        icon="timer"
        title="Turnaround times"
        subtitle="MOU-negotiated TATs override the IRDAI floors (60m preauth, 180m claim) on the SLA timer."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <NumberField
          label="Preauth TAT (minutes)"
          value={form.preauthTatMinutes}
          onChange={(v) => setForm({ ...form, preauthTatMinutes: v })}
          placeholder="e.g. 60"
        />
        <NumberField
          label="Claim TAT (minutes)"
          value={form.claimTatMinutes}
          onChange={(v) => setForm({ ...form, claimTatMinutes: v })}
          placeholder="e.g. 180"
        />
        <CheckboxField
          label="Prior intimation required (emergency)"
          value={form.priorIntimationRequired}
          onChange={(v) => setForm({ ...form, priorIntimationRequired: v })}
        />
        <NumberField
          label="Prior intimation window (hours)"
          value={form.priorIntimationHours}
          onChange={(v) => setForm({ ...form, priorIntimationHours: v })}
          placeholder="e.g. 24"
        />
      </div>

      <SectionHeading
        icon="payments"
        title="Settlement"
        subtitle="Net-N payment term, bank instrument, TDS — drives the payment-due forecast."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <NumberField
          label="Payment term (days)"
          value={form.paymentTermDays}
          onChange={(v) => setForm({ ...form, paymentTermDays: v })}
          placeholder="e.g. 30"
        />
        <SelectField
          label="Payment mode"
          value={form.paymentMode}
          onChange={(v) => setForm({ ...form, paymentMode: v as BankPaymentMode | '' })}
          options={[
            { value: '', label: '— select —' },
            { value: 'rtgs', label: 'RTGS' },
            { value: 'neft', label: 'NEFT' },
            { value: 'cheque', label: 'Cheque' },
            { value: 'mixed', label: 'Mixed' },
          ]}
        />
        <TextField
          label="Bank account reference"
          value={form.bankAccountRef}
          onChange={(v) => setForm({ ...form, bankAccountRef: v })}
          placeholder="Account no. + IFSC or internal ref"
        />
        <NumberField
          label="TDS (%)"
          value={form.tdsPercent}
          onChange={(v) => setForm({ ...form, tdsPercent: v })}
          placeholder="e.g. 2"
        />
        <NumberField
          label="Interest on delayed (% annual)"
          value={form.interestOnDelayedPercent}
          onChange={(v) => setForm({ ...form, interestOnDelayedPercent: v })}
          placeholder="e.g. 9"
        />
        <NumberField
          label="Dispute escalation window (days)"
          value={form.disputeEscalationDays}
          onChange={(v) => setForm({ ...form, disputeEscalationDays: v })}
          placeholder="e.g. 30"
        />
      </div>

      <SectionHeading
        icon="percent"
        title="Tariff modifiers"
        subtitle="Apply across every line at billing time."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <NumberField
          label="Flat discount (%)"
          value={form.flatDiscountPercent}
          onChange={(v) => setForm({ ...form, flatDiscountPercent: v })}
          placeholder="e.g. 15"
        />
        <NumberField
          label="Pharmacy discount (%)"
          value={form.pharmacyDiscountPercent}
          onChange={(v) => setForm({ ...form, pharmacyDiscountPercent: v })}
          placeholder="e.g. 5"
        />
        <CheckboxField
          label="Implant pass-through"
          value={form.implantPassThrough}
          onChange={(v) => setForm({ ...form, implantPassThrough: v })}
        />
        <NumberField
          label="Implant markup cap (%)"
          value={form.implantMarkupCapPercent}
          onChange={(v) => setForm({ ...form, implantMarkupCapPercent: v })}
          placeholder="e.g. 10"
        />
      </div>

      <SectionHeading
        icon="straighten"
        title="Sub-limits"
        subtitle="Per-day or per-claim caps the payer enforces."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <NumberField
          label="Room rent cap (₹/day)"
          value={form.roomRentCapRupeesPerDay}
          onChange={(v) => setForm({ ...form, roomRentCapRupeesPerDay: v })}
        />
        <NumberField
          label="ICU cap (₹/day)"
          value={form.icuCapRupeesPerDay}
          onChange={(v) => setForm({ ...form, icuCapRupeesPerDay: v })}
        />
        <NumberField
          label="Nursing cap (₹/day)"
          value={form.nursingCapRupeesPerDay}
          onChange={(v) => setForm({ ...form, nursingCapRupeesPerDay: v })}
        />
        <NumberField
          label="Consultation cap (₹/claim)"
          value={form.consultationCapRupees}
          onChange={(v) => setForm({ ...form, consultationCapRupees: v })}
        />
        <NumberField
          label="Ambulance cap (₹/claim)"
          value={form.ambulanceCapRupees}
          onChange={(v) => setForm({ ...form, ambulanceCapRupees: v })}
        />
      </div>
    </div>
  );
}

function CoverageTab({
  form,
  setForm,
}: {
  form: TermsFormState;
  setForm: (next: TermsFormState) => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SectionHeading
        icon="health_and_safety"
        title="Waiting periods & coverage"
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <NumberField
          label="Pre-existing waiting (months)"
          value={form.preExistingWaitingMonths}
          onChange={(v) => setForm({ ...form, preExistingWaitingMonths: v })}
          placeholder="e.g. 24"
        />
        <NumberField
          label="Maternity waiting (months)"
          value={form.maternityWaitingMonths}
          onChange={(v) => setForm({ ...form, maternityWaitingMonths: v })}
          placeholder="e.g. 12"
        />
        <CheckboxField
          label="Maternity covered"
          value={form.maternityCovered}
          onChange={(v) => setForm({ ...form, maternityCovered: v })}
        />
        <CheckboxField
          label="Day-care procedures covered"
          value={form.dayCareProceduresCovered}
          onChange={(v) => setForm({ ...form, dayCareProceduresCovered: v })}
        />
        <CheckboxField
          label="Modern treatments covered (robotic, gene therapy, etc.)"
          value={form.modernTreatmentsCovered}
          onChange={(v) => setForm({ ...form, modernTreatmentsCovered: v })}
        />
      </div>

      <SectionHeading
        icon="hub"
        title="Network & compliance"
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <TextField
          label="Network category"
          value={form.networkCategory}
          onChange={(v) => setForm({ ...form, networkCategory: v })}
          placeholder="e.g. Platinum / Tier 1 / Cashless A"
        />
        <NumberField
          label="Notice period for termination (days)"
          value={form.noticePeriodDays}
          onChange={(v) => setForm({ ...form, noticePeriodDays: v })}
          placeholder="e.g. 90"
        />
        <CheckboxField
          label="NABH accreditation required"
          value={form.nabhRequired}
          onChange={(v) => setForm({ ...form, nabhRequired: v })}
        />
        <CheckboxField
          label="NABL accreditation required"
          value={form.nablRequired}
          onChange={(v) => setForm({ ...form, nablRequired: v })}
        />
        <CheckboxField
          label="Auto-renews"
          value={form.autoRenews}
          onChange={(v) => setForm({ ...form, autoRenews: v })}
        />
      </div>

      <SectionHeading
        icon="local_hospital"
        title="Empanelled specialties"
        subtitle="Comma-separated; e.g. cardiology, oncology, orthopaedics."
      />
      <textarea
        rows={2}
        value={form.empanelledSpecialtiesCsv}
        onChange={(e) =>
          setForm({ ...form, empanelledSpecialtiesCsv: e.target.value })
        }
        placeholder="cardiology, oncology, orthopaedics"
        className="w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 text-body text-on-surface outline-none focus:border-primary"
      />

      <SectionHeading icon="notes" title="Notes" />
      <textarea
        rows={4}
        value={form.notes}
        onChange={(e) => setForm({ ...form, notes: e.target.value })}
        placeholder="Free-text rider for anything the structured fields don't capture."
        className="w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 text-body text-on-surface outline-none focus:border-primary"
      />
    </div>
  );
}

// =============================================================================
// Form state + (de)serialization
// =============================================================================

// All numeric fields are kept as strings so the operator can leave
// them blank → null. Booleans stay booleans. Empty enum strings map
// to null on save.
interface TermsFormState {
  copayPercent: string;
  copayFlatRupees: string;
  copayAppliesTo: CopayAppliesTo | '';
  deductibleRupees: string;
  deductibleScope: DeductibleScope | '';
  // Validity
  noticePeriodDays: string;
  autoRenews: boolean;
  // TAT
  preauthTatMinutes: string;
  claimTatMinutes: string;
  priorIntimationRequired: boolean;
  priorIntimationHours: string;
  // Tariff modifiers
  flatDiscountPercent: string;
  pharmacyDiscountPercent: string;
  implantPassThrough: boolean;
  implantMarkupCapPercent: string;
  // Sub-limits
  roomRentCapRupeesPerDay: string;
  icuCapRupeesPerDay: string;
  nursingCapRupeesPerDay: string;
  consultationCapRupees: string;
  ambulanceCapRupees: string;
  // Coverage
  preExistingWaitingMonths: string;
  maternityCovered: boolean;
  maternityWaitingMonths: string;
  dayCareProceduresCovered: boolean;
  modernTreatmentsCovered: boolean;
  // Settlement
  paymentTermDays: string;
  paymentMode: BankPaymentMode | '';
  bankAccountRef: string;
  tdsPercent: string;
  interestOnDelayedPercent: string;
  disputeEscalationDays: string;
  // Network
  networkCategory: string;
  nabhRequired: boolean;
  nablRequired: boolean;
  empanelledSpecialtiesCsv: string;
  notes: string;
}

function emptyTermsForm(): TermsFormState {
  return {
    copayPercent: '',
    copayFlatRupees: '',
    copayAppliesTo: '',
    deductibleRupees: '',
    deductibleScope: '',
    noticePeriodDays: '',
    autoRenews: false,
    preauthTatMinutes: '',
    claimTatMinutes: '',
    priorIntimationRequired: false,
    priorIntimationHours: '',
    flatDiscountPercent: '',
    pharmacyDiscountPercent: '',
    implantPassThrough: false,
    implantMarkupCapPercent: '',
    roomRentCapRupeesPerDay: '',
    icuCapRupeesPerDay: '',
    nursingCapRupeesPerDay: '',
    consultationCapRupees: '',
    ambulanceCapRupees: '',
    preExistingWaitingMonths: '',
    maternityCovered: false,
    maternityWaitingMonths: '',
    dayCareProceduresCovered: true, // matches schema default
    modernTreatmentsCovered: false,
    paymentTermDays: '',
    paymentMode: '',
    bankAccountRef: '',
    tdsPercent: '',
    interestOnDelayedPercent: '',
    disputeEscalationDays: '',
    networkCategory: '',
    nabhRequired: false,
    nablRequired: false,
    empanelledSpecialtiesCsv: '',
    notes: '',
  };
}

function formFromTerms(t: PayerCommercialTerms): TermsFormState {
  return {
    copayPercent: nstr(t.copayPercent),
    copayFlatRupees: paiseToRupeesStr(t.copayFlatPaise),
    copayAppliesTo: t.copayAppliesTo ?? '',
    deductibleRupees: paiseToRupeesStr(t.deductiblePaise),
    deductibleScope: t.deductibleScope ?? '',
    noticePeriodDays: nstr(t.noticePeriodDays),
    autoRenews: t.autoRenews,
    preauthTatMinutes: nstr(t.preauthTatMinutes),
    claimTatMinutes: nstr(t.claimTatMinutes),
    priorIntimationRequired: t.priorIntimationRequired,
    priorIntimationHours: nstr(t.priorIntimationHours),
    flatDiscountPercent: nstr(t.flatDiscountPercent),
    pharmacyDiscountPercent: nstr(t.pharmacyDiscountPercent),
    implantPassThrough: t.implantPassThrough,
    implantMarkupCapPercent: nstr(t.implantMarkupCapPercent),
    roomRentCapRupeesPerDay: paiseToRupeesStr(t.roomRentCapPaisePerDay),
    icuCapRupeesPerDay: paiseToRupeesStr(t.icuCapPaisePerDay),
    nursingCapRupeesPerDay: paiseToRupeesStr(t.nursingCapPaisePerDay),
    consultationCapRupees: paiseToRupeesStr(t.consultationCapPaise),
    ambulanceCapRupees: paiseToRupeesStr(t.ambulanceCapPaise),
    preExistingWaitingMonths: nstr(t.preExistingWaitingMonths),
    maternityCovered: t.maternityCovered,
    maternityWaitingMonths: nstr(t.maternityWaitingMonths),
    dayCareProceduresCovered: t.dayCareProceduresCovered,
    modernTreatmentsCovered: t.modernTreatmentsCovered,
    paymentTermDays: nstr(t.paymentTermDays),
    paymentMode: t.paymentMode ?? '',
    bankAccountRef: t.bankAccountRef ?? '',
    tdsPercent: nstr(t.tdsPercent),
    interestOnDelayedPercent: nstr(t.interestOnDelayedPercent),
    disputeEscalationDays: nstr(t.disputeEscalationDays),
    networkCategory: t.networkCategory ?? '',
    nabhRequired: t.nabhRequired,
    nablRequired: t.nablRequired,
    empanelledSpecialtiesCsv: t.empanelledSpecialties.join(', '),
    notes: t.notes ?? '',
  };
}

function buildUpsertBody(
  payerCode: string,
  f: TermsFormState,
): UpsertPayerCommercialTermsRequest {
  const intOrNull = (s: string): number | null => {
    const t = s.trim();
    if (t.length === 0) return null;
    const n = Number(t);
    return Number.isFinite(n) ? Math.round(n) : null;
  };
  const rupeesToPaise = (s: string): number | null => {
    const r = intOrNull(s);
    return r === null ? null : r * 100;
  };
  const specialties = f.empanelledSpecialtiesCsv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return {
    payerCode,
    copayPercent: intOrNull(f.copayPercent),
    copayFlatPaise: rupeesToPaise(f.copayFlatRupees),
    copayAppliesTo: f.copayAppliesTo === '' ? null : f.copayAppliesTo,
    deductiblePaise: rupeesToPaise(f.deductibleRupees),
    deductibleScope: f.deductibleScope === '' ? null : f.deductibleScope,
    noticePeriodDays: intOrNull(f.noticePeriodDays),
    autoRenews: f.autoRenews,
    preauthTatMinutes: intOrNull(f.preauthTatMinutes),
    claimTatMinutes: intOrNull(f.claimTatMinutes),
    priorIntimationRequired: f.priorIntimationRequired,
    priorIntimationHours: intOrNull(f.priorIntimationHours),
    flatDiscountPercent: intOrNull(f.flatDiscountPercent),
    pharmacyDiscountPercent: intOrNull(f.pharmacyDiscountPercent),
    implantPassThrough: f.implantPassThrough,
    implantMarkupCapPercent: intOrNull(f.implantMarkupCapPercent),
    roomRentCapPaisePerDay: rupeesToPaise(f.roomRentCapRupeesPerDay),
    icuCapPaisePerDay: rupeesToPaise(f.icuCapRupeesPerDay),
    nursingCapPaisePerDay: rupeesToPaise(f.nursingCapRupeesPerDay),
    consultationCapPaise: rupeesToPaise(f.consultationCapRupees),
    ambulanceCapPaise: rupeesToPaise(f.ambulanceCapRupees),
    preExistingWaitingMonths: intOrNull(f.preExistingWaitingMonths),
    maternityCovered: f.maternityCovered,
    maternityWaitingMonths: intOrNull(f.maternityWaitingMonths),
    dayCareProceduresCovered: f.dayCareProceduresCovered,
    modernTreatmentsCovered: f.modernTreatmentsCovered,
    paymentTermDays: intOrNull(f.paymentTermDays),
    paymentMode: f.paymentMode === '' ? null : f.paymentMode,
    bankAccountRef: f.bankAccountRef.trim() === '' ? null : f.bankAccountRef.trim(),
    tdsPercent: intOrNull(f.tdsPercent),
    interestOnDelayedPercent: intOrNull(f.interestOnDelayedPercent),
    disputeEscalationDays: intOrNull(f.disputeEscalationDays),
    networkCategory:
      f.networkCategory.trim() === '' ? null : f.networkCategory.trim(),
    nabhRequired: f.nabhRequired,
    nablRequired: f.nablRequired,
    empanelledSpecialties: specialties,
    notes: f.notes.trim() === '' ? null : f.notes.trim(),
  };
}

// =============================================================================
// Field primitives
// =============================================================================

function TabButton({
  label,
  badge,
  active,
  onClick,
}: {
  label: string;
  badge?: string;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative px-5 py-3 text-body-sm font-medium transition-colors ${
        active
          ? 'border-b-2 border-primary text-primary'
          : 'border-b-2 border-transparent text-on-surface-variant hover:text-on-surface'
      }`}
    >
      {label}
      {badge ? (
        <span className="ml-2 rounded-full bg-secondary/15 px-2 py-0.5 text-[10px] uppercase tracking-eyebrow text-secondary">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

function SectionHeading({
  icon,
  title,
  subtitle,
}: {
  icon: string;
  title: string;
  subtitle?: string;
}): JSX.Element {
  return (
    <div className="flex items-start gap-2">
      <span className="material-symbols-outlined mt-0.5 text-primary">{icon}</span>
      <div>
        <h4 className="text-h3 font-semibold text-on-surface">{title}</h4>
        {subtitle ? (
          <p className="mt-0.5 max-w-2xl text-body-sm text-on-surface-variant">
            {subtitle}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
        {label}
      </label>
      <input
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ''))}
        placeholder={placeholder}
        className="rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 text-body tabular-nums text-on-surface outline-none focus:border-primary"
      />
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 text-body text-on-surface outline-none focus:border-primary"
      />
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 text-body text-on-surface outline-none focus:border-primary"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function CheckboxField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <label className="flex cursor-pointer items-center gap-3">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-outline-variant text-primary focus:ring-primary"
      />
      <span className="text-body-sm text-on-surface">{label}</span>
    </label>
  );
}

// =============================================================================
// Conversions
// =============================================================================

function nstr(n: number | null): string {
  return n === null ? '' : String(n);
}

function paiseToRupeesStr(p: number | null): string {
  if (p === null) return '';
  return String(Math.round(p / 100));
}
