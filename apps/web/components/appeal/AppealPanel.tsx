'use client';

import {
  type AppealResolutionKind,
  type AppealSummary,
  type ClaimStatus,
} from '@claims/contracts';
import { useEffect, useState } from 'react';

import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';
import { CaseApi } from '../../lib/api/case.api';

const APPEAL_ELIGIBLE_FROM: ReadonlySet<ClaimStatus> = new Set([
  'PREAUTH_REJECTED',
  'CLAIM_REJECTED',
  'SHORT_PAID',
]);
const APPEAL_LIVE_FROM: ReadonlySet<ClaimStatus> = new Set([
  'APPEAL_INITIATED',
  'APPEAL_SUBMITTED',
  'APPEAL_RESOLVED',
]);
const APPEAL_HISTORICAL_FROM: ReadonlySet<ClaimStatus> = new Set([
  'PAYMENT_PENDING',
  'PAYMENT_RECEIVED',
  'PAYMENT_RECONCILED',
  'WRITTEN_OFF',
  'CLOSED',
]);

interface Props {
  caseId: string;
  claimId: string;
  status: ClaimStatus;
  onChanged: () => void;
}

export function AppealPanel({
  caseId,
  claimId,
  status,
  onChanged,
}: Props): JSX.Element | null {
  const { showApiError } = useErrorModal();
  const [appeal, setAppeal] = useState<AppealSummary | null>(null);
  const [reason, setReason] = useState('');
  const [resolutionKind, setResolutionKind] = useState<AppealResolutionKind>('approved');
  const [approvedAmount, setApprovedAmount] = useState('');
  const [resolutionNote, setResolutionNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    CaseApi.getAppeal(caseId, claimId)
      .then((r) => {
        if (!cancelled) setAppeal(r.appeal);
      })
      .catch((err: unknown) => {
        if (!cancelled) showApiError(err);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId, claimId, status]);

  const eligible = APPEAL_ELIGIBLE_FROM.has(status);
  const live = APPEAL_LIVE_FROM.has(status);
  const historical = APPEAL_HISTORICAL_FROM.has(status) && appeal !== null;
  if (!eligible && !live && !historical) return null;

  async function action(name: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy(name);
    try {
      await fn();
      onChanged();
    } catch (err) {
      showApiError(err);
    } finally {
      setBusy(null);
    }
  }

  const appealStatusPill = (() => {
    if (!appeal) return null;
    const s = appeal.status.toUpperCase();
    let dot = 'bg-outline';
    let cls = 'bg-surface-container text-on-surface-variant border-outline-variant/50';
    if (s.includes('RESOLVED')) {
      if (appeal.resolutionKind === 'approved') {
        cls = 'bg-green-50 text-green-700 border-green-100';
        dot = 'bg-green-500';
      } else if (appeal.resolutionKind === 'rejected') {
        cls = 'bg-red-50 text-red-700 border-red-100';
        dot = 'bg-red-500';
      } else {
        cls = 'bg-amber-50 text-amber-700 border-amber-100';
        dot = 'bg-amber-500';
      }
    } else if (s.includes('SUBMITTED')) {
      cls = 'bg-amber-50 text-amber-700 border-amber-100';
      dot = 'bg-amber-500';
    } else if (s.includes('INITIATED')) {
      cls = 'bg-blue-50 text-blue-700 border-blue-100';
      dot = 'bg-blue-500';
    }
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-body-sm font-medium ${cls}`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        {appeal.status}
        {appeal.resolutionKind ? ` · ${appeal.resolutionKind}` : ''}
      </span>
    );
  })();

  return (
    <section className="glass space-y-5 rounded-xl p-6">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">gavel</span>
          <h3 className="text-h3 font-h3 text-on-surface">Appeal</h3>
        </div>
        {appealStatusPill}
      </header>

      {appeal ? (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-body-sm md:grid-cols-2">
          <div className="flex flex-col">
            <dt className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
              Reason
            </dt>
            <dd className="text-on-surface">{appeal.reason}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
              Started
            </dt>
            <dd className="text-on-surface">
              {new Date(appeal.startedAt).toLocaleString()}
            </dd>
          </div>
          {appeal.submittedAt ? (
            <div className="flex flex-col">
              <dt className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                Submitted
              </dt>
              <dd className="text-on-surface">
                {new Date(appeal.submittedAt).toLocaleString()}
              </dd>
            </div>
          ) : null}
          {appeal.resolvedAt ? (
            <div className="flex flex-col">
              <dt className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                Resolved
              </dt>
              <dd className="text-on-surface">
                {new Date(appeal.resolvedAt).toLocaleString()}
              </dd>
            </div>
          ) : null}
          {appeal.approvedAmount !== null ? (
            <div className="flex flex-col">
              <dt className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                Approved (₹)
              </dt>
              <dd className="font-mono tabular-nums text-on-surface">
                ₹{appeal.approvedAmount.toLocaleString('en-IN')}
              </dd>
            </div>
          ) : null}
          {appeal.resolutionNote ? (
            <div className="flex flex-col md:col-span-2">
              <dt className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                Note
              </dt>
              <dd className="text-on-surface">{appeal.resolutionNote}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {eligible && appeal === null ? (
        <div className="space-y-2 border-t border-surface-variant/50 pt-4">
          <label
            htmlFor="appeal-reason"
            className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant"
          >
            Ground for appeal
          </label>
          <textarea
            id="appeal-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="e.g. Procedure is covered under rider B; surgeon notes attached."
            className="glass-input glass-input--sm resize-none"
          />
          <button
            onClick={() =>
              action('start', () => CaseApi.startAppeal(caseId, claimId, { reason }))
            }
            disabled={busy === 'start' || reason.trim().length === 0}
            className="btn-primary"
            style={{ padding: '8px 18px', fontSize: '13px' }}
          >
            <span
              className="material-symbols-outlined text-[18px]"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              gavel
            </span>
            {busy === 'start' ? '…' : 'Start appeal'}
          </button>
        </div>
      ) : null}

      {status === 'APPEAL_INITIATED' ? (
        <div className="space-y-2 border-t border-surface-variant/50 pt-4">
          <p className="text-body-sm text-on-surface-variant">
            Submit the appeal once supporting documents are uploaded under this claim. Real
            outbound to the payer is a Sprint 5 backlog item — for now this just freezes the
            package locally.
          </p>
          <button
            onClick={() =>
              action('submit', () =>
                CaseApi.submitAppeal(caseId, claimId, { supportingDocumentIds: [] }),
              )
            }
            disabled={busy === 'submit'}
            className="btn-primary"
            style={{ padding: '8px 18px', fontSize: '13px' }}
          >
            <span
              className="material-symbols-outlined text-[18px]"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              send
            </span>
            {busy === 'submit' ? '…' : 'Submit appeal'}
          </button>
        </div>
      ) : null}

      {status === 'APPEAL_SUBMITTED' ? (
        <div className="space-y-3 border-t border-surface-variant/50 pt-4">
          <p className="text-body-sm text-on-surface-variant">
            Record the payer&apos;s decision:
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="relative">
              <select
                value={resolutionKind}
                onChange={(e) => setResolutionKind(e.target.value as AppealResolutionKind)}
                className="glass-input glass-input--sm appearance-none pr-10"
              >
                <option value="approved">approved</option>
                <option value="partially_approved">partially_approved</option>
                <option value="rejected">rejected</option>
              </select>
              <span className="material-symbols-outlined pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[18px] text-on-surface-variant">
                expand_more
              </span>
            </div>
            {resolutionKind !== 'rejected' ? (
              <input
                type="number"
                placeholder="Approved amount (₹)"
                value={approvedAmount}
                onChange={(e) => setApprovedAmount(e.target.value)}
                className="glass-input glass-input--sm w-48 font-mono tabular-nums"
              />
            ) : null}
            <input
              type="text"
              placeholder="Note (optional)"
              value={resolutionNote}
              onChange={(e) => setResolutionNote(e.target.value)}
              className="glass-input glass-input--sm flex-1"
            />
            <button
              onClick={() =>
                action('resolve', () =>
                  CaseApi.resolveAppeal(caseId, claimId, {
                    kind: resolutionKind,
                    ...(resolutionKind !== 'rejected' && approvedAmount
                      ? { approvedAmount: Number.parseInt(approvedAmount, 10) }
                      : {}),
                    ...(resolutionNote ? { note: resolutionNote } : {}),
                  }),
                )
              }
              disabled={
                busy === 'resolve' || (resolutionKind !== 'rejected' && !approvedAmount)
              }
              className="btn-primary"
              style={{ padding: '8px 18px', fontSize: '13px' }}
            >
              <span className="material-symbols-outlined text-[18px]">check_circle</span>
              {busy === 'resolve' ? '…' : 'Record resolution'}
            </button>
          </div>
        </div>
      ) : null}

      {status === 'APPEAL_RESOLVED' ? (
        <div className="flex items-start gap-2 rounded-lg border border-secondary-container/30 bg-secondary-fixed/40 p-3 text-body-sm text-on-surface">
          <span className="material-symbols-outlined text-secondary">info</span>
          <span>
            Appeal rejected. Use <strong>Write off</strong> in the Settlement panel to close
            out the claim.
          </span>
        </div>
      ) : null}
    </section>
  );
}
