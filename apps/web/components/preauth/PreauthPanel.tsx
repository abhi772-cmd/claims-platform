'use client';

import { type ClaimStatus, type PreauthDraft } from '@claims/contracts';
import { useEffect, useState, type FormEvent } from 'react';

import { EligibilityPurposeButton } from '../eligibility/EligibilityPurposeButton';
import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';
import { useToast } from '../toast/ToastProvider';
import { CaseApi } from '../../lib/api/case.api';

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
  onChanged: () => void;
}

export function PreauthPanel({
  caseId,
  claimId,
  status,
  rail,
  onChanged,
}: Props): JSX.Element | null {
  const { showApiError } = useErrorModal();
  const showToast = useToast();
  const [draft, setDraft] = useState<PreauthDraft>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);

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
      <form onSubmit={save} className="space-y-4">
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
            value={draft.requestedAmount !== undefined ? String(draft.requestedAmount) : ''}
            onChange={(v) =>
              setDraft((d) => ({
                ...d,
                requestedAmount: v ? Number.parseInt(v, 10) : undefined,
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
