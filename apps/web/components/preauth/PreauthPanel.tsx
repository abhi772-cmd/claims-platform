'use client';

import { type ClaimStatus, type PreauthDraft } from '@claims/contracts';
import { useEffect, useState, type FormEvent } from 'react';

import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';
import { CaseApi } from '../../lib/api/case.api';

// Statuses where the executive can edit the draft. Once submitted, the
// draft is read-only and the panel just shows the snapshot.
const EDITABLE_STATUSES: ReadonlySet<ClaimStatus> = new Set([
  'ELIGIBILITY_VERIFIED',
  'PREAUTH_DRAFTING',
  'PREAUTH_QUEUED',
]);

const SUBMITTABLE_STATUSES: ReadonlySet<ClaimStatus> = new Set([
  'PREAUTH_DRAFTING',
]);

interface Props {
  caseId: string;
  claimId: string;
  status: ClaimStatus;
  onChanged: () => void;
}

export function PreauthPanel({ caseId, claimId, status, onChanged }: Props): JSX.Element | null {
  const { showApiError } = useErrorModal();
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
  if (!EDITABLE_STATUSES.has(status) && !status.startsWith('PREAUTH_') && status !== 'ENHANCEMENT_DRAFTING') {
    return null;
  }

  async function save(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSaving(true);
    try {
      const out = await CaseApi.savePreauthDraft(caseId, claimId, draft);
      setDraft(out.draft);
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
    <section className="space-y-3 rounded-md bg-neutral-0 p-6 shadow-md">
      <h2 className="text-sm font-semibold text-neutral-700">Pre-auth</h2>
      <form onSubmit={save} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
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
        <div className="space-y-1">
          <label className="text-xs text-neutral-500">Clinical justification</label>
          <textarea
            value={draft.clinicalJustification ?? ''}
            onChange={(e) =>
              setDraft((d) => ({ ...d, clinicalJustification: e.target.value || undefined }))
            }
            disabled={!editable}
            rows={4}
            className="w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 text-xs disabled:bg-neutral-50"
          />
        </div>
        {editable ? (
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={saving}
              className="rounded-sm border border-neutral-300 px-3 py-2 text-xs hover:bg-neutral-50 disabled:opacity-60"
            >
              {saving ? 'Saving…' : 'Save draft'}
            </button>
            {canSubmit ? (
              <button
                type="button"
                onClick={submit}
                disabled={submitting}
                className="rounded-sm bg-primary-600 px-3 py-2 text-xs font-medium text-neutral-0 hover:bg-primary-700 disabled:opacity-60"
              >
                {submitting ? 'Submitting…' : 'Submit pre-auth'}
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
    <div className="space-y-1">
      <label className="text-xs text-neutral-500">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={`w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 text-xs disabled:bg-neutral-50 ${
          mono ? 'font-mono' : ''
        }`}
      />
    </div>
  );
}
