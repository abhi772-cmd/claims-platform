'use client';

import {
  type AppealResolutionKind,
  type AppealSummary,
  type ClaimStatus,
} from '@claims/contracts';
import { useEffect, useState } from 'react';

import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';
import { CaseApi } from '../../lib/api/case.api';

// Where in the claim lifecycle the panel is meaningful. The appeal
// row may exist past these statuses (history), so we render the
// summary read-only after APPEAL_RESOLVED leads to PAYMENT_PENDING /
// WRITTEN_OFF / CLOSED downstream — operators still want to see
// "this claim was appealed, here's the outcome".
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

  // Hide the panel entirely when the claim has never been in an
  // appealable lifecycle (e.g. fresh INITIATED claim). The appeal row
  // also won't exist there, so the GET would just return null anyway.
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

  return (
    <section className="space-y-4 rounded-md bg-neutral-0 p-6 shadow-md">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-700">Appeal</h2>
        {appeal ? (
          <span className="text-xs uppercase tracking-wide text-neutral-500">
            {appeal.status}
            {appeal.resolutionKind ? ` · ${appeal.resolutionKind}` : ''}
          </span>
        ) : null}
      </header>

      {appeal ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
          <dt className="text-neutral-500">Reason</dt>
          <dd className="text-neutral-700">{appeal.reason}</dd>
          <dt className="text-neutral-500">Started</dt>
          <dd className="text-neutral-700">
            {new Date(appeal.startedAt).toLocaleString()}
          </dd>
          {appeal.submittedAt ? (
            <>
              <dt className="text-neutral-500">Submitted</dt>
              <dd className="text-neutral-700">
                {new Date(appeal.submittedAt).toLocaleString()}
              </dd>
            </>
          ) : null}
          {appeal.resolvedAt ? (
            <>
              <dt className="text-neutral-500">Resolved</dt>
              <dd className="text-neutral-700">
                {new Date(appeal.resolvedAt).toLocaleString()}
              </dd>
            </>
          ) : null}
          {appeal.approvedAmount !== null ? (
            <>
              <dt className="text-neutral-500">Approved (₹)</dt>
              <dd className="text-neutral-700">{appeal.approvedAmount}</dd>
            </>
          ) : null}
          {appeal.resolutionNote ? (
            <>
              <dt className="text-neutral-500">Note</dt>
              <dd className="text-neutral-700">{appeal.resolutionNote}</dd>
            </>
          ) : null}
        </dl>
      ) : null}

      {eligible && appeal === null ? (
        <div className="space-y-2 border-t border-neutral-100 pt-3">
          <label htmlFor="appeal-reason" className="block text-xs font-medium text-neutral-700">
            Ground for appeal
          </label>
          <textarea
            id="appeal-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="e.g. Procedure is covered under rider B; surgeon notes attached."
            className="w-full rounded-sm border border-neutral-200 bg-neutral-0 px-2 py-1 text-xs"
          />
          <button
            onClick={() =>
              action('start', () => CaseApi.startAppeal(caseId, claimId, { reason }))
            }
            disabled={busy === 'start' || reason.trim().length === 0}
            className="rounded-sm bg-primary-600 px-2 py-1 text-xs font-medium text-neutral-0 hover:bg-primary-700 disabled:opacity-60"
          >
            {busy === 'start' ? '…' : 'Start appeal'}
          </button>
        </div>
      ) : null}

      {status === 'APPEAL_INITIATED' ? (
        <div className="space-y-2 border-t border-neutral-100 pt-3">
          <p className="text-xs text-neutral-500">
            Submit the appeal once supporting documents are uploaded under this
            claim. Real outbound to the payer is a Sprint 5 backlog item — for
            now this just freezes the package locally.
          </p>
          <button
            onClick={() =>
              action('submit', () =>
                CaseApi.submitAppeal(caseId, claimId, { supportingDocumentIds: [] }),
              )
            }
            disabled={busy === 'submit'}
            className="rounded-sm bg-primary-600 px-2 py-1 text-xs font-medium text-neutral-0 hover:bg-primary-700 disabled:opacity-60"
          >
            {busy === 'submit' ? '…' : 'Submit appeal'}
          </button>
        </div>
      ) : null}

      {status === 'APPEAL_SUBMITTED' ? (
        <div className="space-y-2 border-t border-neutral-100 pt-3">
          <p className="text-xs text-neutral-500">Record the payer&apos;s decision:</p>
          <div className="flex flex-wrap items-end gap-2">
            <select
              value={resolutionKind}
              onChange={(e) => setResolutionKind(e.target.value as AppealResolutionKind)}
              className="rounded-sm border border-neutral-200 bg-neutral-0 px-2 py-1 text-xs"
            >
              <option value="approved">approved</option>
              <option value="partially_approved">partially_approved</option>
              <option value="rejected">rejected</option>
            </select>
            {resolutionKind !== 'rejected' ? (
              <input
                type="number"
                placeholder="Approved amount (₹)"
                value={approvedAmount}
                onChange={(e) => setApprovedAmount(e.target.value)}
                className="w-44 rounded-sm border border-neutral-200 bg-neutral-0 px-2 py-1 text-xs"
              />
            ) : null}
            <input
              type="text"
              placeholder="Note (optional)"
              value={resolutionNote}
              onChange={(e) => setResolutionNote(e.target.value)}
              className="flex-1 rounded-sm border border-neutral-200 bg-neutral-0 px-2 py-1 text-xs"
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
                busy === 'resolve' ||
                (resolutionKind !== 'rejected' && !approvedAmount)
              }
              className="rounded-sm bg-primary-600 px-2 py-1 text-xs font-medium text-neutral-0 hover:bg-primary-700 disabled:opacity-60"
            >
              {busy === 'resolve' ? '…' : 'Record resolution'}
            </button>
          </div>
        </div>
      ) : null}

      {status === 'APPEAL_RESOLVED' ? (
        // Slice AJ: favourable resolutions auto-chain to PAYMENT_PENDING
        // via SettlementService.expectPayment, so a claim that's still
        // sitting at APPEAL_RESOLVED is necessarily a rejected one.
        <div className="border-t border-neutral-100 pt-3 text-xs text-neutral-500">
          Appeal rejected. Use Write off in the Settlement panel to
          close out the claim.
        </div>
      ) : null}
    </section>
  );
}
