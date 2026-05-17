'use client';

// EOB-line matcher panel.
//
// Phase 1 — read-only suggestions with confidence + signals.
// Phase 2 adds reviewer-confirm semantics: each row exposes a
// "pick" dropdown (bill line OR explicit "no match") + a dispute
// checkbox + Confirm/Reset. When confirmed, the matcher locks the
// suggestion at high confidence and the row displays a "confirmed"
// badge with a Reset link.
//
// Bill lines are loaded once on mount so the dropdown can offer
// alternatives to the auto-suggested row.

import {
  type BillLineItem,
  type BillLineItemsListResponse,
  type ClaimStatus,
  type EobLineMatch,
  type EobLineMatchesResponse,
  type EobMatchConfidence,
} from '@claims/contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';
import { BillLineItemApi } from '../../lib/api/bill-line-item.api';
import { EobLineMatcherApi } from '../../lib/api/eob-line-matcher.api';

const VISIBLE_FROM: ReadonlySet<ClaimStatus> = new Set([
  'CLAIM_APPROVED',
  'CLAIM_PARTIALLY_APPROVED',
  'PAYMENT_PENDING',
  'PAYMENT_RECEIVED',
  'PAYMENT_RECONCILED',
  'SHORT_PAID',
  'WRITTEN_OFF',
  'APPEAL_RESOLVED',
  'CLOSED',
]);

interface Props {
  caseId: string;
  claimId: string;
  status: ClaimStatus;
}

const CONFIDENCE_STYLE: Record<EobMatchConfidence, { label: string; cls: string }> = {
  high: {
    label: 'High',
    cls: 'bg-green-50 text-green-700 border-green-200',
  },
  medium: {
    label: 'Medium',
    cls: 'bg-amber-50 text-amber-700 border-amber-200',
  },
  low: {
    label: 'Low',
    cls: 'bg-surface-container-low text-on-surface-variant border-outline-variant/40',
  },
  none: {
    label: 'No match',
    cls: 'bg-surface-container-low text-on-surface-variant border-outline-variant/40',
  },
};

function fmtINR(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function SignalChip({ children }: { children: string }): JSX.Element {
  return (
    <span className="rounded-full border border-outline-variant/40 bg-surface-container-lowest/70 px-2 py-0.5 text-[10px] uppercase tracking-eyebrow text-on-surface-variant">
      {children}
    </span>
  );
}

export function EobLineMatchesPanel({
  caseId,
  claimId,
  status,
}: Props): JSX.Element | null {
  const { showApiError } = useErrorModal();
  const [data, setData] = useState<EobLineMatchesResponse | null>(null);
  const [billLines, setBillLines] = useState<BillLineItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyDeductionIndex, setBusyDeductionIndex] = useState<number | null>(null);

  const visible = VISIBLE_FROM.has(status);

  // Parallel load — matcher + bill lines. Bill lines feed the
  // confirm-row dropdown so the reviewer can pick an alternative
  // to the matcher's auto-suggest.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      EobLineMatcherApi.list(caseId, claimId),
      BillLineItemApi.list(caseId, claimId).catch(() => ({
        lines: [],
        totals: { medicalPaise: 0, nonMedicalPaise: 0, grandTotalPaise: 0 },
      }) as BillLineItemsListResponse),
    ])
      .then(([matches, bills]) => {
        if (cancelled) return;
        setData(matches);
        setBillLines(bills.lines);
      })
      .catch((err) => {
        if (!cancelled) showApiError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, caseId, claimId, showApiError]);

  const handleConfirm = useCallback(
    async (
      deductionIndex: number,
      billLineItemId: string | null,
      isDispute: boolean,
    ) => {
      setBusyDeductionIndex(deductionIndex);
      try {
        const next = await EobLineMatcherApi.confirm(caseId, claimId, {
          deductionIndex,
          billLineItemId,
          isDispute,
        });
        setData(next);
      } catch (err) {
        showApiError(err);
      } finally {
        setBusyDeductionIndex(null);
      }
    },
    [caseId, claimId, showApiError],
  );

  const handleReset = useCallback(
    async (deductionIndex: number) => {
      setBusyDeductionIndex(deductionIndex);
      try {
        const next = await EobLineMatcherApi.reset(caseId, claimId, deductionIndex);
        setData(next);
      } catch (err) {
        showApiError(err);
      } finally {
        setBusyDeductionIndex(null);
      }
    },
    [caseId, claimId, showApiError],
  );

  if (!visible) return null;
  if (loading && !data) {
    return (
      <section className="glass space-y-3 rounded-xl p-6">
        <p className="text-body-sm text-on-surface-variant">Loading EOB matches…</p>
      </section>
    );
  }
  if (!data || data.matches.length === 0) return null;

  return (
    <section className="glass space-y-4 rounded-xl p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">compare_arrows</span>
          <div>
            <h3 className="text-h3 font-h3 text-on-surface">EOB-line matches</h3>
            <p className="mt-0.5 text-body-sm text-on-surface-variant">
              Suggested mapping between payer deductions and the hospital&apos;s
              classified bill lines. Confirm a row to lock the reviewer&apos;s
              choice; the matcher won&apos;t auto-suggest over it.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-body-sm">
          <span className="rounded-full bg-surface-container-low/60 px-3 py-1 font-mono tabular-nums text-on-surface-variant">
            matched {fmtINR(data.totalMatchedAmount)} / {fmtINR(data.totalDeductionAmount)}
          </span>
          {data.disputeCandidateCount > 0 ? (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 font-medium text-amber-700"
              title="Payer deducted lines the hospital tagged as medical — consider appealing."
            >
              <span className="material-symbols-outlined text-[14px]">gavel</span>
              {data.disputeCandidateCount} dispute candidate
              {data.disputeCandidateCount === 1 ? '' : 's'}
            </span>
          ) : null}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-outline-variant/30">
        <table className="w-full border-collapse text-left text-body-sm">
          <thead className="bg-surface-container-low/40">
            <tr>
              <th className="px-3 py-2 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                Payer deduction
              </th>
              <th className="px-3 py-2 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                Matched bill line
              </th>
              <th className="px-3 py-2 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                Signals / confirm
              </th>
              <th className="px-3 py-2 text-right text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {data.matches.map((m) => (
              <MatchRow
                key={m.deductionIndex}
                match={m}
                billLines={billLines}
                busy={busyDeductionIndex === m.deductionIndex}
                onConfirm={handleConfirm}
                onReset={handleReset}
              />
            ))}
          </tbody>
        </table>
      </div>

      {data.unmatchedBillLineIds.length > 0 ? (
        <p className="text-[12px] text-on-surface-variant">
          {data.unmatchedBillLineIds.length} bill line
          {data.unmatchedBillLineIds.length === 1 ? '' : 's'} not picked by any
          deduction — typically the medical items the payer accepted in full.
        </p>
      ) : null}
    </section>
  );
}

interface MatchRowProps {
  match: EobLineMatch;
  billLines: BillLineItem[];
  busy: boolean;
  onConfirm: (
    deductionIndex: number,
    billLineItemId: string | null,
    isDispute: boolean,
  ) => Promise<void>;
  onReset: (deductionIndex: number) => Promise<void>;
}

function MatchRow({
  match,
  billLines,
  busy,
  onConfirm,
  onReset,
}: MatchRowProps): JSX.Element {
  const conf = CONFIDENCE_STYLE[match.confidence];
  // Local state seeded from the matcher's current opinion. The
  // reviewer can change the dropdown / dispute toggle independent
  // of the auto-suggest, then click Confirm to persist.
  const [pickedBillLineId, setPickedBillLineId] = useState<string | null>(
    match.billLineItemId,
  );
  const [pickedDispute, setPickedDispute] = useState<boolean>(
    match.isDisputeCandidate === true,
  );

  // Re-seed when the parent's match prop changes (server roundtrip
  // after confirm/reset replaces the matches array). Without this,
  // the dropdown sticks at the pre-confirm state.
  useEffect(() => {
    setPickedBillLineId(match.billLineItemId);
    setPickedDispute(match.isDisputeCandidate === true);
  }, [match.billLineItemId, match.isDisputeCandidate, match.confirmed]);

  const billLineOptions = useMemo(() => billLines, [billLines]);
  const pickedLine = useMemo(
    () => billLineOptions.find((b) => b.id === pickedBillLineId) ?? null,
    [billLineOptions, pickedBillLineId],
  );

  return (
    <tr
      className={
        match.confirmed
          ? 'border-t border-outline-variant/20 bg-green-50/40 align-top'
          : 'border-t border-outline-variant/20 align-top'
      }
    >
      <td className="px-3 py-2">
        <p className="font-medium text-on-surface">{match.deductionCategory}</p>
        {match.deductionReason ? (
          <p className="mt-0.5 text-[12px] text-on-surface-variant">
            {match.deductionReason}
          </p>
        ) : null}
        <p className="mt-0.5 font-mono text-[12px] tabular-nums text-on-surface-variant">
          {fmtINR(match.deductionAmount)}
        </p>
      </td>
      <td className="px-3 py-2">
        {/* Bill-line picker. The matcher's suggestion is pre-selected
            but the reviewer can switch to any other bill row (or
            "no match"). When the deduction has no bill-line
            options at all (operator hasn't saved the bill yet) we
            still show the auto-suggest plain text. */}
        {billLineOptions.length > 0 ? (
          <select
            value={pickedBillLineId ?? ''}
            onChange={(e) => setPickedBillLineId(e.target.value || null)}
            disabled={busy}
            className="w-full rounded-md border border-outline-variant/40 bg-surface-container-lowest/70 px-2 py-1 text-[12px] text-on-surface outline-none focus:border-primary focus:ring-1 focus:ring-primary-container"
            aria-label="Bill line for this deduction"
          >
            <option value="">— No matching bill line —</option>
            {billLineOptions.map((b) => (
              <option key={b.id} value={b.id}>
                {b.description} · {fmtINR(b.amountPaise)}
              </option>
            ))}
          </select>
        ) : (
          <p className="text-[12px] italic text-on-surface-variant">
            No bill lines saved on this claim.
          </p>
        )}
        {pickedLine !== null ? (
          <p className="mt-1 font-mono text-[11px] tabular-nums text-on-surface-variant">
            {fmtINR(pickedLine.amountPaise)} · {pickedLine.medical ? 'medical' : 'non-medical'}
          </p>
        ) : null}
        <label className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] text-on-surface-variant">
          <input
            type="checkbox"
            checked={pickedDispute}
            onChange={(e) => setPickedDispute(e.target.checked)}
            disabled={busy || pickedBillLineId === null}
            className="h-3.5 w-3.5 rounded border-outline-variant/40 accent-amber-600"
          />
          Mark as dispute candidate
        </label>
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-1">
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-eyebrow ${conf.cls}`}
            >
              {conf.label}
            </span>
            {match.confirmed ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-[10px] font-medium text-green-700">
                <span className="material-symbols-outlined text-[12px]">verified</span>
                confirmed
                {match.confirmedAt ? <> · {fmtTime(match.confirmedAt)}</> : null}
              </span>
            ) : null}
            {match.signals.includes('amount_exact') ? (
              <SignalChip>amount exact</SignalChip>
            ) : null}
            {match.signals.includes('amount_close') ? (
              <SignalChip>amount ~close</SignalChip>
            ) : null}
            {match.signals.includes('token_overlap') ? (
              <SignalChip>tokens</SignalChip>
            ) : null}
            {match.signals.includes('category_alignment') ? (
              <SignalChip>category</SignalChip>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {match.confirmed ? (
              <button
                type="button"
                onClick={() => void onReset(match.deductionIndex)}
                disabled={busy}
                className="text-[11px] text-primary hover:underline"
              >
                {busy ? '…' : 'Reset'}
              </button>
            ) : (
              <button
                type="button"
                onClick={() =>
                  void onConfirm(match.deductionIndex, pickedBillLineId, pickedDispute)
                }
                disabled={busy}
                className="rounded-md border border-primary bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
              >
                {busy ? '…' : 'Confirm'}
              </button>
            )}
          </div>
        </div>
      </td>
      <td className="px-3 py-2 text-right align-top font-mono tabular-nums text-on-surface">
        {fmtINR(match.deductionAmount)}
      </td>
    </tr>
  );
}
