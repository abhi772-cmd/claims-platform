'use client';

// Operator-facing insurance-plan summary on the case-detail page.
//
// Before this slice the component was literally `return null` —
// the slot existed but rendered nothing. This implementation
// composes the case row + the claim row + the latest
// `eligibility.verified` ClaimEvent into a visible card with
// four mini-stats (plan name / sum insured / room rent cap /
// approved-to-date) plus a status hint.
//
// What this slice deliberately does NOT show:
//   * Deductibles / co-pay percentages — those live in the
//     FHIR Coverage.benefit[] tree which the parser doesn't
//     extract yet. They'll appear when a richer FHIR parser
//     lands (separate slice).
//   * Per-procedure sub-limits beyond room-rent — same reason.
//
// The card is robust against three states:
//   1. status='not_run' — eligibility hasn't run; render a
//      muted "verify eligibility to populate" hint with link
//      to /cases/[id] (the eligibility action lives there).
//   2. status='failed' — verification was attempted but the
//      payer rejected; render the failure reason in amber.
//   3. status='verified' — full happy path; render the stats.

import { type InsurancePlanResponse } from '@claims/contracts';
import { useEffect, useState, type ReactNode } from 'react';

import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';
import { InsurancePlanApi } from '../../lib/api/insurance-plan.api';

interface Props {
  caseId: string;
  claimId: string;
  // Operator-supplied policy number from the eligibility input
  // — surfaced in the card header so the operator can confirm
  // the displayed plan matches what they captured at intake.
  // Unused if absent.
  defaultPolicyNumber?: string | null;
}

function fmtINR(rupees: number): string {
  return `₹${rupees.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function fmtPaise(paise: number): string {
  return fmtINR(paise / 100);
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function PlanPreviewCard({
  caseId,
  claimId,
  defaultPolicyNumber,
}: Props): JSX.Element {
  const { showApiError } = useErrorModal();
  const [data, setData] = useState<InsurancePlanResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    InsurancePlanApi.get(caseId, claimId)
      .then((r) => {
        if (!cancelled) setData(r);
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
  }, [caseId, claimId, showApiError]);

  if (loading && data === null) {
    return (
      <section className="glass rounded-xl p-6">
        <p className="text-body-sm text-on-surface-variant">
          Loading insurance plan…
        </p>
      </section>
    );
  }
  if (!data) return <></>;

  return (
    <section className="glass space-y-4 rounded-xl p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">policy</span>
          <div>
            <h3 className="text-h3 font-h3 text-on-surface">Insurance plan</h3>
            <p className="mt-0.5 text-body-sm text-on-surface-variant">
              {data.planName ??
                (defaultPolicyNumber
                  ? `Policy ${defaultPolicyNumber}`
                  : 'Plan summary')}
            </p>
          </div>
        </div>
        <StatusPill status={data.status} verifiedAt={data.verifiedAt} />
      </div>

      {data.status === 'not_run' ? (
        <p className="rounded-lg border border-outline-variant/30 bg-surface-container-lowest/50 p-3 text-body-sm text-on-surface-variant">
          Eligibility hasn&apos;t been verified yet. Run the eligibility check
          to populate the plan details from the payer&apos;s response.
        </p>
      ) : null}

      {data.status === 'failed' && data.failureReason ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-body-sm text-amber-700">
          <span className="material-symbols-outlined mt-0.5 text-[18px]">
            warning
          </span>
          <div>
            <p className="font-medium">Eligibility check failed</p>
            <p className="mt-0.5">{data.failureReason}</p>
          </div>
        </div>
      ) : null}

      {/* Mini-stats grid — renders in all states. Missing values
          (e.g. eligibility not yet run) show '—' rather than
          hiding the row, so the card doesn't shrink/grow as the
          operator advances the claim. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MiniStat
          label="Plan"
          value={data.planName ?? '—'}
          mono={false}
        />
        <MiniStat
          label="Sum insured"
          value={data.sumInsured !== null ? fmtINR(data.sumInsured) : '—'}
          tone="primary"
        />
        <MiniStat
          label="Room rent cap"
          value={
            data.policyRoomRentLimitPaise !== null
              ? `${fmtPaise(data.policyRoomRentLimitPaise)}/day`
              : '—'
          }
          hint={
            data.policyRoomRentLimitPaise === null
              ? 'not captured at intake'
              : undefined
          }
        />
        <MiniStat
          label="Approved to date"
          value={
            data.approvedToDatePaise !== null
              ? fmtPaise(data.approvedToDatePaise)
              : '—'
          }
          tone={
            data.approvedToDatePaise !== null && data.approvedToDatePaise > 0
              ? 'success'
              : 'neutral'
          }
        />
      </div>

      {/* Coverage hint — surfaces the gap between sum insured
          and what's already been approved, so the operator can
          gauge how much headroom is left on the policy. Only
          renders when both numbers are present. */}
      {data.sumInsured !== null && data.approvedToDatePaise !== null ? (
        <CoverageHint
          sumInsuredRupees={data.sumInsured}
          approvedPaise={data.approvedToDatePaise}
        />
      ) : null}
    </section>
  );
}

function StatusPill({
  status,
  verifiedAt,
}: {
  status: InsurancePlanResponse['status'];
  verifiedAt: string | null;
}): JSX.Element {
  if (status === 'not_run') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-outline-variant/50 bg-surface-container px-2.5 py-1 text-body-sm font-medium text-on-surface-variant">
        <span className="h-1.5 w-1.5 rounded-full bg-outline" />
        Eligibility pending
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-red-100 bg-red-50 px-2.5 py-1 text-body-sm font-medium text-red-700">
        <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
        Verification failed
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-green-100 bg-green-50 px-2.5 py-1 text-body-sm font-medium text-green-700"
      title={verifiedAt ? `Verified ${fmtDateTime(verifiedAt)}` : undefined}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
      Verified{verifiedAt ? ` · ${fmtDateTime(verifiedAt)}` : ''}
    </span>
  );
}

function MiniStat({
  label,
  value,
  hint,
  tone = 'neutral',
  mono = true,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'neutral' | 'primary' | 'success';
  mono?: boolean;
}): JSX.Element {
  const valCls =
    tone === 'primary'
      ? 'text-primary'
      : tone === 'success'
        ? 'text-green-700'
        : 'text-on-surface';
  return (
    <div className="rounded-lg border border-outline-variant/30 bg-surface-container-lowest/50 p-3">
      <p className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
        {label}
      </p>
      <p
        className={`mt-1 text-body font-bold ${mono ? 'font-mono tabular-nums' : ''} ${valCls}`}
      >
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-[10px] text-on-surface-variant">{hint}</p>
      ) : null}
    </div>
  );
}

function CoverageHint({
  sumInsuredRupees,
  approvedPaise,
}: {
  sumInsuredRupees: number;
  approvedPaise: number;
}): JSX.Element {
  // Sum insured is in rupees, approved is in paise. Convert
  // both to rupees for the gap calculation.
  const sumInsuredPaise = sumInsuredRupees * 100;
  const remainingPaise = Math.max(0, sumInsuredPaise - approvedPaise);
  const pctUsed =
    sumInsuredPaise > 0
      ? Math.min(100, Math.round((approvedPaise / sumInsuredPaise) * 100))
      : 0;
  const tone =
    pctUsed >= 90
      ? { bar: 'bg-red-600', text: 'text-red-700' }
      : pctUsed >= 60
        ? { bar: 'bg-amber-500', text: 'text-amber-700' }
        : { bar: 'bg-primary', text: 'text-primary' };
  return (
    <div className="rounded-lg border border-outline-variant/30 bg-surface-container-lowest/40 p-3">
      <div className="flex items-baseline justify-between text-body-sm">
        <span className="text-on-surface-variant">Sum-insured used</span>
        <span className={`font-mono tabular-nums font-medium ${tone.text}`}>
          {pctUsed}% · {fmtPaise(remainingPaise)} headroom
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-container-high">
        <div
          className={`h-full rounded-full ${tone.bar}`}
          style={{ width: `${pctUsed}%` }}
        />
      </div>
    </div>
  );
}
