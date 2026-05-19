'use client';

// Coverage details card — renders the 4 preview tiles (Sum insured,
// Deductible, Co-pay, Room limit) plus the plan name + verified/failed
// banner whenever a verify-by-identifiers call has returned a
// non-null result. Extracted from the legacy "Verify coverage" card so
// the Find patient widget owns the lookup and this card owns the
// display. Self-hides until the parent passes a non-null verifyResult.

import { type VerifyCoverageByIdentifiersResponse } from '@claims/contracts';

interface Props {
  result: VerifyCoverageByIdentifiersResponse | null;
}

const LABEL_CLS =
  'mb-1 block text-eyebrow uppercase tracking-eyebrow text-on-surface-variant';

function formatRupees(value: number | null): string {
  if (value === null) return '—';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(value);
}

function formatCoPay(percent: number | null, rupees: number | null): string {
  if (percent !== null) return `${percent}%`;
  if (rupees !== null) return formatRupees(rupees);
  return '—';
}

export function CoverageDetailsCard({ result }: Props): JSX.Element | null {
  if (result === null) return null;

  const banner = result.verified ? (
    <div className="mb-4 flex items-center gap-2 rounded-lg border border-tertiary/30 bg-tertiary-container px-3 py-2">
      <span className="material-symbols-outlined text-tertiary">verified</span>
      <p className="text-body-sm text-on-surface">
        Coverage verified for{' '}
        <span className="font-semibold">{result.planName ?? 'this plan'}</span>.
      </p>
    </div>
  ) : (
    <div className="mb-4 flex items-center gap-2 rounded-lg border border-error/30 bg-error-container/60 px-3 py-2">
      <span className="material-symbols-outlined text-error">error</span>
      <p className="text-body-sm text-on-surface">
        Coverage check failed: {result.failureReason ?? 'see integration messages for details.'}
      </p>
    </div>
  );

  return (
    <div className="glass rounded-xl p-6">
      <div className="mb-2 flex items-center gap-2">
        <span className="material-symbols-outlined text-primary">policy</span>
        <h3 className="text-h3 font-h3 text-on-surface">Coverage details</h3>
      </div>
      {banner}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Sum insured" value={formatRupees(result.sumInsuredRupees)} />
        <Tile label="Deductible" value={formatRupees(result.deductibleRupees)} />
        <Tile label="Co-pay" value={formatCoPay(result.coPayPercent, result.coPayRupees)} />
        <Tile label="Room limit" value={result.roomRentLimitRupees !== null ? `${formatRupees(result.roomRentLimitRupees)} / day` : '—'} />
      </div>
      <p className="mt-3 text-body-sm text-on-surface-variant">
        Correlation: <span className="font-mono tabular-nums">{result.correlationId}</span>
      </p>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-outline-variant/40 bg-surface-container-lowest/50 px-3 py-3">
      <div className={LABEL_CLS}>{label}</div>
      <div className="text-h3 font-semibold tabular-nums text-on-surface">{value}</div>
    </div>
  );
}
