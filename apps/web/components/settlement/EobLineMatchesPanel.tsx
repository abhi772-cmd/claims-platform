'use client';

// EOB-line matcher (Phase 1) — read-only suggestion panel.
//
// Shown on the case-detail page after the SettlementPanel when
// the claim has a settlement carrying deductions AND the claim
// has saved bill_line_item rows. The panel lists each payer
// deduction with the matcher's best-guess bill row, a confidence
// badge, and a "dispute candidate" amber tag when the payer
// stripped a hospital-medical row.
//
// No mutation here — Phase 2 will add reviewer-confirm /
// reviewer-reject affordances. For now the panel is observability
// only: it surfaces what the matcher thinks so the reviewer can
// spot patterns before they manually reconcile.

import {
  type ClaimStatus,
  type EobLineMatch,
  type EobLineMatchesResponse,
  type EobMatchConfidence,
} from '@claims/contracts';
import { useEffect, useState } from 'react';

import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';
import { EobLineMatcherApi } from '../../lib/api/eob-line-matcher.api';

// Same status set the SettlementPanel uses — deductions only
// exist on adjudicated claims, so the panel only loads then.
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
  const [loading, setLoading] = useState(false);

  const visible = VISIBLE_FROM.has(status);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    EobLineMatcherApi.list(caseId, claimId)
      .then((res) => {
        if (!cancelled) setData(res);
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

  if (!visible) return null;
  if (loading && !data) {
    return (
      <section className="glass space-y-3 rounded-xl p-6">
        <p className="text-body-sm text-on-surface-variant">Loading EOB matches…</p>
      </section>
    );
  }
  if (!data || data.matches.length === 0) {
    // No deductions on the settlement → nothing to match. Render
    // nothing rather than an empty panel; reviewer doesn't need to
    // see "0 of 0 matched" noise.
    return null;
  }

  return (
    <section className="glass space-y-4 rounded-xl p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">compare_arrows</span>
          <div>
            <h3 className="text-h3 font-h3 text-on-surface">EOB-line matches</h3>
            <p className="mt-0.5 text-body-sm text-on-surface-variant">
              Suggested mapping between payer deductions and the hospital&apos;s
              classified bill lines. Phase 1 — read-only suggestions; reviewer
              still confirms by hand.
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
                Signals
              </th>
              <th className="px-3 py-2 text-right text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {data.matches.map((m) => (
              <MatchRow key={m.deductionIndex} match={m} />
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

function MatchRow({ match }: { match: EobLineMatch }): JSX.Element {
  const conf = CONFIDENCE_STYLE[match.confidence];
  return (
    <tr className="border-t border-outline-variant/20 align-top">
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
        {match.billLineDescription ? (
          <>
            <p className="text-on-surface">{match.billLineDescription}</p>
            {match.billLineAmountPaise !== null ? (
              <p className="mt-0.5 font-mono text-[12px] tabular-nums text-on-surface-variant">
                {fmtINR(match.billLineAmountPaise)}
              </p>
            ) : null}
            {match.isDisputeCandidate === true ? (
              <p className="mt-1 inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                <span className="material-symbols-outlined text-[12px]">gavel</span>
                dispute candidate
              </p>
            ) : null}
          </>
        ) : (
          <span className="text-[12px] italic text-on-surface-variant">
            No matching bill line — review manually.
          </span>
        )}
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap items-center gap-1">
          <span
            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-eyebrow ${conf.cls}`}
          >
            {conf.label}
          </span>
          {match.signals.includes('amount_exact') ? (
            <SignalChip>amount exact</SignalChip>
          ) : null}
          {match.signals.includes('token_overlap') ? (
            <SignalChip>tokens</SignalChip>
          ) : null}
          {match.signals.includes('category_alignment') ? (
            <SignalChip>category</SignalChip>
          ) : null}
        </div>
      </td>
      <td className="px-3 py-2 text-right font-mono tabular-nums text-on-surface">
        {fmtINR(match.deductionAmount)}
      </td>
    </tr>
  );
}
