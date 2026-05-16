'use client';

// T3-1 — CFO variance dashboard.
//
// Three sections on the page:
//   1. KPI tiles (top): total billed, approved, paid, leakage.
//   2. Aging breakdown + top payers (middle): outstanding-by-bucket
//      and worst-leakage payers side-by-side.
//   3. Claims drill-down (bottom): filterable by bucket + payerCode.
//
// Glass cards, teal + amber only, sentence case, tabular numerics on
// every amount. Aging buckets click through to filter the drill-down.

import {
  type VarianceAgingBucket,
  type VarianceAgingRow,
  type VarianceClaimRow,
  type VarianceClaimsResponse,
  type VariancePayerRow,
  type VarianceSummaryResponse,
} from '@claims/contracts';
import { useEffect, useState } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { VarianceApi } from '../../../../lib/api/variance.api';

const BUCKET_LABEL: Record<VarianceAgingBucket, string> = {
  d0_7: '0–7 days',
  d8_14: '8–14 days',
  d15_30: '15–30 days',
  d31_plus: '31+ days',
};

const BUCKET_TONE: Record<VarianceAgingBucket, string> = {
  d0_7: 'border-primary/20 bg-primary/5 text-primary',
  d8_14: 'border-primary/30 bg-primary/10 text-primary',
  d15_30: 'border-amber-500/30 bg-amber-500/10 text-amber-700',
  d31_plus: 'border-error/30 bg-error/10 text-error',
};

function rupees(paise: number | null): string {
  if (paise === null) return '—';
  const sign = paise < 0 ? '-' : '';
  return `${sign}₹${(Math.abs(paise) / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

function percent(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export default function VariancePage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const [summary, setSummary] = useState<VarianceSummaryResponse | null>(null);
  const [byPayer, setByPayer] = useState<VariancePayerRow[]>([]);
  const [claims, setClaims] = useState<VarianceClaimRow[]>([]);
  const [bucketFilter, setBucketFilter] = useState<VarianceAgingBucket | null>(null);
  const [payerFilter, setPayerFilter] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      setLoading(true);
      try {
        const [s, p] = await Promise.all([VarianceApi.summary(), VarianceApi.byPayer()]);
        if (cancelled) return;
        setSummary(s);
        setByPayer(p.rows);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadClaims(): Promise<void> {
      try {
        const res: VarianceClaimsResponse = await VarianceApi.claims({
          ...(bucketFilter ? { bucket: bucketFilter } : {}),
          ...(payerFilter ? { payerCode: payerFilter } : {}),
          limit: 50,
        });
        if (!cancelled) setClaims(res.rows);
      } catch (err) {
        if (!cancelled) showApiError(err);
      }
    }
    void loadClaims();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucketFilter, payerFilter]);

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6">
      {/* Header */}
      <section className="glass flex flex-col items-start justify-between gap-4 rounded-xl p-6 md:flex-row md:items-end">
        <div>
          <h2 className="text-h2 font-h2 text-primary">Variance dashboard</h2>
          <p className="mt-1 text-body text-on-surface-variant">
            Approved-vs-billed and short-payment leakage across the tenant,
            with aging buckets to flag overdue settlements.
          </p>
        </div>
        <div className="text-body-sm text-on-surface-variant">
          {summary?.reportedAt
            ? `As of ${new Date(summary.reportedAt).toLocaleString('en-IN')}`
            : null}
        </div>
      </section>

      {/* KPI tiles */}
      {loading && !summary ? (
        <p className="text-body-sm text-on-surface-variant">Loading…</p>
      ) : summary ? (
        <>
          {/* When the tenant has zero adjudicated claims, all five
              KPIs are ₹0. Without context the page reads like a
              broken integration; this banner reassures that the
              numbers are accurate and points at what populates them. */}
          {summary.contributingClaimCount === 0 ? (
            <div className="glass flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50/60 p-4">
              <span className="material-symbols-outlined mt-0.5 text-amber-700">info</span>
              <p className="text-body-sm text-on-surface">
                <span className="font-medium text-on-surface">No adjudicated claims yet.</span>{' '}
                Variance figures populate after the first claim is approved or paid.
                Aging buckets, top payers, and the drill-down below will also fill in then.
              </p>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
            <KpiTile label="Total billed" value={rupees(summary.totalBilled)} />
            <KpiTile label="Total approved" value={rupees(summary.totalApproved)} tone="primary" />
            <KpiTile label="Total paid" value={rupees(summary.totalPaid)} />
            <KpiTile
              label="Billed variance"
              value={rupees(summary.totalBilledVariance)}
              tone="amber"
              hint={`${summary.contributingClaimCount} claims`}
            />
            <KpiTile label="Short-pay" value={rupees(summary.totalShortPay)} tone="error" />
          </div>
        </>
      ) : null}

      {/* Aging + top payers row */}
      <div className="grid grid-cols-12 gap-6">
        {/* Aging */}
        <section className="glass col-span-12 flex flex-col gap-4 rounded-xl p-6 lg:col-span-5">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">timelapse</span>
            <h3 className="text-h3 font-h3 text-on-surface">Outstanding by aging</h3>
          </div>
          <p className="text-body-sm text-on-surface-variant">
            Unsettled claims grouped by days since submission. Click a bucket
            to filter the drill-down below.
          </p>
          {summary && summary.aging.length > 0 ? (
            <div className="flex flex-col gap-2">
              {summary.aging.map((row) => (
                <AgingRow
                  key={row.bucket}
                  row={row}
                  active={bucketFilter === row.bucket}
                  onClick={() =>
                    setBucketFilter((b) => (b === row.bucket ? null : row.bucket))
                  }
                />
              ))}
            </div>
          ) : (
            <p className="text-body-sm text-on-surface-variant">
              No unsettled claims.
            </p>
          )}
        </section>

        {/* Top payers */}
        <section className="glass col-span-12 flex flex-col gap-4 rounded-xl p-6 lg:col-span-7">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">leaderboard</span>
            <h3 className="text-h3 font-h3 text-on-surface">Top payers by leakage</h3>
          </div>
          {byPayer.length === 0 ? (
            <p className="text-body-sm text-on-surface-variant">
              No adjudicated claims yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead className="bg-primary/5">
                  <tr>
                    <th className="px-4 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                      Payer
                    </th>
                    <th className="px-4 py-3 text-right text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                      Claims
                    </th>
                    <th className="px-4 py-3 text-right text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                      Billed
                    </th>
                    <th className="px-4 py-3 text-right text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                      Variance
                    </th>
                    <th className="px-4 py-3 text-right text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                      Rate
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {byPayer.map((row) => {
                    const active = payerFilter === row.payerCode;
                    return (
                      <tr
                        key={row.payerCode}
                        onClick={() =>
                          setPayerFilter((p) => (p === row.payerCode ? null : row.payerCode))
                        }
                        className={`cursor-pointer border-t border-outline-variant/20 ${
                          active ? 'bg-primary/5' : 'hover:bg-primary/5'
                        }`}
                      >
                        <td className="px-4 py-3 font-mono text-body-sm text-on-surface">
                          {row.payerCode === '__unassigned__' ? '(unassigned)' : row.payerCode}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-body-sm tabular-nums text-on-surface-variant">
                          {row.claimCount}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-body-sm tabular-nums text-on-surface">
                          {rupees(row.totalBilled)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-body-sm tabular-nums text-error">
                          {rupees(row.netLeakage)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-body-sm tabular-nums text-on-surface">
                          {percent(row.varianceRate)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {/* Drill-down */}
      <section className="glass flex flex-col gap-4 rounded-xl p-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">filter_list</span>
            <h3 className="text-h3 font-h3 text-on-surface">
              {bucketFilter || payerFilter ? 'Filtered claims' : 'Recent claims'}
            </h3>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {bucketFilter ? (
              <FilterPill
                label={`Bucket: ${BUCKET_LABEL[bucketFilter]}`}
                onClear={() => setBucketFilter(null)}
              />
            ) : null}
            {payerFilter ? (
              <FilterPill
                label={`Payer: ${payerFilter === '__unassigned__' ? '(unassigned)' : payerFilter}`}
                onClear={() => setPayerFilter(null)}
              />
            ) : null}
          </div>
        </div>
        {claims.length === 0 ? (
          <p className="text-body-sm text-on-surface-variant">
            No claims match the current filters.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead className="bg-primary/5">
                <tr>
                  <th className="px-4 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                    Patient
                  </th>
                  <th className="px-4 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                    Payer
                  </th>
                  <th className="px-4 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                    Status
                  </th>
                  <th className="px-4 py-3 text-right text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                    Billed
                  </th>
                  <th className="px-4 py-3 text-right text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                    Approved
                  </th>
                  <th className="px-4 py-3 text-right text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                    Paid
                  </th>
                  <th className="px-4 py-3 text-right text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                    Variance
                  </th>
                  <th className="px-4 py-3 text-right text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                    Aging
                  </th>
                </tr>
              </thead>
              <tbody>
                {claims.map((c) => (
                  <tr key={c.claimId} className="border-t border-outline-variant/20">
                    <td className="px-4 py-3 text-body-sm text-on-surface">
                      {c.patientName || '—'}
                    </td>
                    <td className="px-4 py-3 font-mono text-body-sm text-on-surface-variant">
                      {c.payerCode ?? '—'}
                    </td>
                    <td className="px-4 py-3 font-mono text-body-sm text-on-surface-variant">
                      {c.status}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-body-sm tabular-nums text-on-surface">
                      {rupees(c.claimAmount)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-body-sm tabular-nums text-on-surface">
                      {rupees(c.approvedAmount)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-body-sm tabular-nums text-on-surface">
                      {rupees(c.paidAmount)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-body-sm tabular-nums text-error">
                      {rupees(c.billedVariance)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-body-sm tabular-nums text-on-surface-variant">
                      {c.agingDays !== null ? `${c.agingDays}d` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function KpiTile({
  label,
  value,
  tone = 'neutral',
  hint,
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'primary' | 'amber' | 'error';
  hint?: string;
}): JSX.Element {
  const TONE_VALUE: Record<typeof tone, string> = {
    neutral: 'text-on-surface',
    primary: 'text-primary',
    amber: 'text-amber-700',
    error: 'text-error',
  };
  return (
    <div className="glass rounded-xl p-5">
      <p className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">{label}</p>
      <p className={`mt-2 text-h2 font-h2 tabular-nums ${TONE_VALUE[tone]}`}>{value}</p>
      {hint ? (
        <p className="mt-1 text-body-sm text-on-surface-variant">{hint}</p>
      ) : null}
    </div>
  );
}

function AgingRow({
  row,
  active,
  onClick,
}: {
  row: VarianceAgingRow;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`flex items-center justify-between rounded-lg border px-4 py-3 text-left transition-all ${
        BUCKET_TONE[row.bucket]
      } ${active ? 'ring-2 ring-primary/30' : ''}`}
    >
      <span className="font-medium">{BUCKET_LABEL[row.bucket]}</span>
      <span className="flex items-center gap-4 text-body-sm">
        <span className="font-mono tabular-nums">{row.count} claims</span>
        <span className="font-mono tabular-nums">{rupees(row.outstandingAmount)}</span>
      </span>
    </button>
  );
}

function FilterPill({
  label,
  onClear,
}: {
  label: string;
  onClear: () => void;
}): JSX.Element {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-body-sm text-primary">
      {label}
      <button onClick={onClear} aria-label="Clear filter" className="text-primary/70 hover:text-primary">
        <span className="material-symbols-outlined text-[16px]">close</span>
      </button>
    </span>
  );
}

