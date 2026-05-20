'use client';

import {
  type ChecklistAdmissionType,
  type ClaimStatus,
  type Package,
  type PreauthDraft,
} from '@claims/contracts';
import { useEffect, useState, type FormEvent } from 'react';

import { PreauthChecklist } from './PreauthChecklist';
import { EligibilityPurposeButton } from '../eligibility/EligibilityPurposeButton';
import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';
import { useToast } from '../toast/ToastProvider';
import { CaseApi } from '../../lib/api/case.api';
import { MasterDataApi } from '../../lib/api/master-data.api';

// Package.amount is paise; preauth requestedAmount is paise end-to-end
// (the FHIR builder divides by 100 for the Money value). Keep both in
// paise so auto-fill and the costing spine never disagree.
const formatPaiseInr = (paise: number): string =>
  `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

const EDITABLE_STATUSES: ReadonlySet<ClaimStatus> = new Set([
  'ELIGIBILITY_VERIFIED',
  'PREAUTH_DRAFTING',
  'PREAUTH_QUEUED',
]);

const SUBMITTABLE_STATUSES: ReadonlySet<ClaimStatus> = new Set(['PREAUTH_DRAFTING']);

interface Props {
  caseId: string;
  claimId: string;
  status: ClaimStatus;
  // PMJAY mandates a fresh `purpose=benefits` eligibility cycle right
  // before preauth draft. Private rails (NHCX) skip the purpose field
  // on the wire; self-pay hides the affordance entirely.
  rail: 'nhcx' | 'pmjay' | 'self_pay';
  // T1.1 — narrow the required-document checklist the same way the
  // backend submit gate does, so the panel shows exactly what blocks
  // submit. Optional: absent on legacy cases that never set a payer.
  payerCode?: string;
  admissionType?: ChecklistAdmissionType;
  onChanged: () => void;
}

export function PreauthPanel({
  caseId,
  claimId,
  status,
  rail,
  payerCode,
  admissionType,
  onChanged,
}: Props): JSX.Element | null {
  const { showApiError } = useErrorModal();
  const showToast = useToast();
  const [draft, setDraft] = useState<PreauthDraft>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // D-023 — HBP package picker. PMJAY is package-driven, so for PMJAY
  // claims the package is the primary input: choosing one auto-fills the
  // requested amount from its fixed rate (still editable). Hidden on
  // other rails in Phase 1 (D-008 lists the package selector as a
  // PMJAY-specific affordance).
  const [pkgQuery, setPkgQuery] = useState('');
  const [pkgResults, setPkgResults] = useState<Package[]>([]);
  const [pkgSearching, setPkgSearching] = useState(false);
  // Display name for the selected package (the draft only stores the
  // code, so the chip resolves the name for a human-readable label).
  const [selectedPackageName, setSelectedPackageName] = useState<string | null>(null);
  const showPackagePicker = rail === 'pmjay';

  useEffect(() => {
    let cancelled = false;
    CaseApi.getPreauthDraft(caseId, claimId)
      .then((d) => {
        if (cancelled) return;
        if ('draft' in d && d.draft) setDraft(d.draft);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (!cancelled) showApiError(err);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId, claimId]);

  // Debounced package typeahead. Only searches PMJAY HBP packages.
  useEffect(() => {
    if (!showPackagePicker) return;
    const q = pkgQuery.trim();
    if (q.length < 2) {
      setPkgResults([]);
      return;
    }
    let cancelled = false;
    setPkgSearching(true);
    const handle = setTimeout(() => {
      MasterDataApi.listPackages({ q, pmjayHbp: true, active: true, limit: 8 })
        .then((r) => {
          if (!cancelled) setPkgResults(r.packages);
        })
        .catch(() => {
          if (!cancelled) setPkgResults([]);
        })
        .finally(() => {
          if (!cancelled) setPkgSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [pkgQuery, showPackagePicker]);

  // Resolve the selected package's display name. On reload the draft
  // carries only the code, so fetch the name once for the chip label.
  // Cosmetic — failures are swallowed and the chip falls back to code.
  useEffect(() => {
    if (!showPackagePicker) return;
    const code = draft.packageCode;
    if (!code || selectedPackageName) return;
    let cancelled = false;
    MasterDataApi.listPackages({ q: code, pmjayHbp: true, limit: 5 })
      .then((r) => {
        if (cancelled) return;
        const match = r.packages.find((p) => p.code === code);
        if (match) setSelectedPackageName(match.name);
      })
      .catch(() => {
        /* name is cosmetic; ignore */
      });
    return () => {
      cancelled = true;
    };
  }, [draft.packageCode, selectedPackageName, showPackagePicker]);

  if (!loaded) return null;
  if (
    !EDITABLE_STATUSES.has(status) &&
    !status.startsWith('PREAUTH_') &&
    status !== 'ENHANCEMENT_DRAFTING'
  ) {
    return null;
  }

  async function save(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSaving(true);
    try {
      const out = await CaseApi.savePreauthDraft(caseId, claimId, draft);
      setDraft(out.draft);
      showToast({ tone: 'success', message: 'Pre-auth draft saved.' });
      onChanged();
    } catch (err) {
      showApiError(err);
    } finally {
      setSaving(false);
    }
  }

  async function submit(): Promise<void> {
    setSubmitting(true);
    try {
      await CaseApi.submitPreauth(caseId, claimId);
      showToast({
        tone: 'success',
        message: 'Pre-auth submitted to payer — IRDAI 1-hour timer started.',
      });
      onChanged();
    } catch (err) {
      showApiError(err);
    } finally {
      setSubmitting(false);
    }
  }

  function selectPackage(pkg: Package): void {
    setDraft((d) => ({
      ...d,
      packageCode: pkg.code,
      // Auto-fill the rate (paise). Stays editable in the amount field
      // below — D-023 auto-fills but does NOT hard-lock (enhancement /
      // implant cases need a higher figure).
      requestedAmount: pkg.amount,
      // Seed the planned-procedure text from the package name if the
      // operator hasn't typed one, so they aren't re-typing it.
      plannedProcedure: d.plannedProcedure ?? pkg.name,
    }));
    setSelectedPackageName(pkg.name);
    setPkgQuery('');
    setPkgResults([]);
  }

  function changePackage(): void {
    // Reopen the search to swap the package. We keep requestedAmount —
    // picking a new package overwrites it, so a straight swap doesn't
    // lose the operator's figure. (Removing a package entirely is part
    // of the Phase 3 multi-line management.)
    setSelectedPackageName(null);
    setDraft((d) => ({ ...d, packageCode: undefined }));
  }

  const editable = EDITABLE_STATUSES.has(status);
  const canSubmit = SUBMITTABLE_STATUSES.has(status);

  return (
    <section className="glass space-y-5 rounded-xl p-6">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-primary">medical_services</span>
        <h3 className="text-h3 font-h3 text-on-surface">Pre-auth</h3>
      </div>
      {rail !== 'self_pay' ? (
        <EligibilityPurposeButton
          caseId={caseId}
          claimId={claimId}
          rail={rail}
          purpose="benefits"
          onCompleted={() => onChanged()}
        />
      ) : null}
      <PreauthChecklist
        caseId={caseId}
        claimId={claimId}
        rail={rail}
        editable={editable}
        onChanged={onChanged}
        {...(payerCode ? { payerCode } : {})}
        {...(draft.packageCode ? { packageCode: draft.packageCode } : {})}
        {...(admissionType ? { admissionType } : {})}
      />
      <form onSubmit={save} className="space-y-4">
        {showPackagePicker ? (
          <div className="space-y-1.5">
            <label className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
              HBP package
            </label>
            {draft.packageCode ? (
              <div className="glass flex items-center justify-between gap-3 rounded-lg px-3 py-2">
                <span className="min-w-0">
                  {selectedPackageName ? (
                    <span className="block truncate text-sm text-on-surface">
                      {selectedPackageName}
                    </span>
                  ) : null}
                  <span className="font-mono text-xs text-on-surface-variant">
                    {draft.packageCode}
                  </span>
                </span>
                {editable ? (
                  <button
                    type="button"
                    onClick={changePackage}
                    className="shrink-0 text-xs text-on-surface-variant hover:text-on-surface"
                  >
                    Change
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="relative">
                <input
                  type="text"
                  value={pkgQuery}
                  onChange={(e) => setPkgQuery(e.target.value)}
                  disabled={!editable}
                  placeholder="Search HBP package by code or name…"
                  className="glass-input glass-input--sm"
                />
                {pkgResults.length > 0 ? (
                  <ul className="glass absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-lg p-1">
                    {pkgResults.map((pkg) => (
                      <li key={pkg.code}>
                        <button
                          type="button"
                          onClick={() => selectPackage(pkg)}
                          className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left hover:bg-white/5"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm text-on-surface">{pkg.name}</span>
                            <span className="font-mono text-xs text-on-surface-variant">{pkg.code}</span>
                          </span>
                          <span className="shrink-0 text-sm tabular-nums text-on-surface">
                            {formatPaiseInr(pkg.amount)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {pkgSearching ? (
                  <p className="mt-1 text-xs text-on-surface-variant">Searching…</p>
                ) : null}
              </div>
            )}
            {draft.packageCode && draft.requestedAmount !== undefined ? (
              <p className="text-xs text-on-surface-variant">
                Amount auto-filled from package rate: {formatPaiseInr(draft.requestedAmount)} —
                editable below.
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            label="Diagnosis (description)"
            value={draft.diagnosisDescription ?? ''}
            onChange={(v) => setDraft((d) => ({ ...d, diagnosisDescription: v || undefined }))}
            disabled={!editable}
          />
          <Field
            label="ICD code"
            value={draft.diagnosisIcdCode ?? ''}
            mono
            onChange={(v) => setDraft((d) => ({ ...d, diagnosisIcdCode: v || undefined }))}
            disabled={!editable}
          />
          <Field
            label="Planned procedure"
            value={draft.plannedProcedure ?? ''}
            onChange={(v) => setDraft((d) => ({ ...d, plannedProcedure: v || undefined }))}
            disabled={!editable}
          />
          <Field
            label="Procedure code"
            value={draft.procedureCode ?? ''}
            mono
            onChange={(v) => setDraft((d) => ({ ...d, procedureCode: v || undefined }))}
            disabled={!editable}
          />
          <Field
            label="Estimated LoS (days)"
            type="number"
            value={
              draft.estimatedLengthOfStayDays !== undefined
                ? String(draft.estimatedLengthOfStayDays)
                : ''
            }
            onChange={(v) =>
              setDraft((d) => ({
                ...d,
                estimatedLengthOfStayDays: v ? Number.parseInt(v, 10) : undefined,
              }))
            }
            disabled={!editable}
          />
          <Field
            label="Requested amount (₹)"
            type="number"
            // Rupee-denominated field; requestedAmount is stored in PAISE
            // (matches EnhancementPanel / NonMedicalStripCalculator and
            // the FHIR Money conversion). Display = paise/100; entry =
            // round(rupees * 100).
            value={
              draft.requestedAmount !== undefined
                ? String(Math.round(draft.requestedAmount / 100))
                : ''
            }
            onChange={(v) =>
              setDraft((d) => ({
                ...d,
                requestedAmount: v ? Math.round(Number.parseFloat(v) * 100) : undefined,
              }))
            }
            disabled={!editable}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
            Clinical justification
          </label>
          <textarea
            value={draft.clinicalJustification ?? ''}
            onChange={(e) =>
              setDraft((d) => ({ ...d, clinicalJustification: e.target.value || undefined }))
            }
            disabled={!editable}
            rows={4}
            className="glass-input glass-input--sm resize-none"
          />
        </div>
        {editable ? (
          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              disabled={saving}
              className="btn-outline"
              style={{ padding: '10px 20px', fontSize: '13px' }}
            >
              <span className="material-symbols-outlined text-[18px]">save</span>
              {saving ? 'Saving…' : 'Save draft'}
            </button>
            {canSubmit ? (
              <button
                type="button"
                onClick={submit}
                disabled={submitting}
                className="btn-cta group"
                style={{ padding: '10px 22px', fontSize: '13px' }}
              >
                {submitting ? 'Submitting…' : 'Submit pre-auth'}
                <span
                  className="material-symbols-outlined ml-1 text-[18px] transition-transform group-hover:translate-x-1"
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  arrow_forward
                </span>
              </button>
            ) : null}
          </div>
        ) : null}
      </form>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  mono = false,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: 'text' | 'number';
  mono?: boolean;
  disabled?: boolean;
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <label className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={`glass-input glass-input--sm ${mono ? 'font-mono tabular-nums' : ''}`}
      />
    </div>
  );
}
