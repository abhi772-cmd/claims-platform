'use client';

// Plan-preview card — case-detail surface for the
// `insuranceplan/request` chain-root lookup.
//
// Four states:
//   idle      — no lookup yet → show the lookup form
//   pending   — POST acked, waiting on insuranceplan/on_request → spinner + Refresh
//   resolved  — callback landed → plan name / type / sum-insured / period / network
//   failed    — server-side failure or payer rejection → reason + Retry
//
// The card fetches the latest lookup on mount; after a successful
// POST it re-fetches once immediately and then offers a manual
// Refresh (the callback is async; we don't long-poll).

import {
  type InsurancePlanLookup,
  InsurancePlanRequestSchema,
} from '@claims/contracts';
import { useCallback, useEffect, useState } from 'react';

import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';
import { InsurancePlanApi } from '../../lib/api/insurance-plan.api';

interface Props {
  caseId: string;
  claimId: string;
  /** Pre-fills the policy-number field when the case already has one. */
  defaultPolicyNumber?: string;
}

export function PlanPreviewCard({
  caseId,
  claimId,
  defaultPolicyNumber = '',
}: Props): JSX.Element {
  const { showApiError, showError } = useErrorModal();
  const [lookup, setLookup] = useState<InsurancePlanLookup | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Form state — only shown in the idle / failed states.
  const [payerCode, setPayerCode] = useState('');
  const [payerDisplayName, setPayerDisplayName] = useState('');
  const [policyNumber, setPolicyNumber] = useState(defaultPolicyNumber);
  const [providerId, setProviderId] = useState('');

  const fetchLatest = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        const row = await InsurancePlanApi.getForClaim(caseId, claimId, signal);
        setLookup(row);
      } catch (err) {
        showApiError(err);
      } finally {
        setLoaded(true);
      }
    },
    [caseId, claimId, showApiError],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    void fetchLatest(ctrl.signal);
    return () => {
      ctrl.abort();
    };
  }, [fetchLatest]);

  const onRefresh = async (): Promise<void> => {
    setRefreshing(true);
    await fetchLatest();
    setRefreshing(false);
  };

  const onSubmit = async (): Promise<void> => {
    const parsed = InsurancePlanRequestSchema.safeParse({
      payerCode: payerCode.trim(),
      policyNumber: policyNumber.trim(),
      providerId: providerId.trim(),
      ...(payerDisplayName.trim() ? { payerDisplayName: payerDisplayName.trim() } : {}),
    });
    if (!parsed.success) {
      showError('VALIDATION_FAILED', parsed.error.issues[0]?.message);
      return;
    }
    setSubmitting(true);
    try {
      await InsurancePlanApi.lookupForClaim(caseId, claimId, parsed.data);
      await fetchLatest();
    } catch (err) {
      showApiError(err);
    } finally {
      setSubmitting(false);
    }
  };

  // ---- render ----

  return (
    <section className="glass rounded-xl p-6">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className="material-symbols-outlined text-primary"
            style={{ fontVariationSettings: "'FILL' 1" }}
          >
            shield
          </span>
          <div>
            <h3 className="text-h3 font-h3 text-on-surface">Insurance plan</h3>
            <p className="text-body-sm text-on-surface-variant">
              insuranceplan/request — plan details from the payer
            </p>
          </div>
        </div>
        {lookup ? <StatusPill status={lookup.status} /> : null}
      </header>

      <div className="mt-5">
        {!loaded ? (
          <p className="text-body-sm text-on-surface-variant">Loading…</p>
        ) : lookup === null || lookup.status === 'failed' ? (
          <LookupForm
            failed={lookup?.status === 'failed' ? lookup.failureReason : null}
            payerCode={payerCode}
            setPayerCode={setPayerCode}
            payerDisplayName={payerDisplayName}
            setPayerDisplayName={setPayerDisplayName}
            policyNumber={policyNumber}
            setPolicyNumber={setPolicyNumber}
            providerId={providerId}
            setProviderId={setProviderId}
            submitting={submitting}
            onSubmit={() => void onSubmit()}
          />
        ) : lookup.status === 'pending' ? (
          <PendingState
            lookup={lookup}
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
          />
        ) : (
          <ResolvedState
            lookup={lookup}
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
          />
        )}
      </div>
    </section>
  );
}

// -----------------------------------------------------------------------------

function StatusPill({ status }: { status: InsurancePlanLookup['status'] }): JSX.Element {
  const map: Record<
    InsurancePlanLookup['status'],
    { cls: string; dot: string; label: string }
  > = {
    pending: {
      cls: 'bg-amber-50 text-amber-700 border-amber-100',
      dot: 'bg-amber-500',
      label: 'Waiting on payer',
    },
    resolved: {
      cls: 'bg-green-50 text-green-700 border-green-100',
      dot: 'bg-green-500',
      label: 'Resolved',
    },
    failed: {
      cls: 'bg-red-50 text-red-700 border-red-100',
      dot: 'bg-red-500',
      label: 'Failed',
    },
  };
  const m = map[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-body-sm font-medium ${m.cls}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}

interface LookupFormProps {
  failed: string | null;
  payerCode: string;
  setPayerCode: (v: string) => void;
  payerDisplayName: string;
  setPayerDisplayName: (v: string) => void;
  policyNumber: string;
  setPolicyNumber: (v: string) => void;
  providerId: string;
  setProviderId: (v: string) => void;
  submitting: boolean;
  onSubmit: () => void;
}

function LookupForm(p: LookupFormProps): JSX.Element {
  const labelCls = 'text-eyebrow uppercase tracking-eyebrow text-on-surface-variant';
  return (
    <div className="space-y-4">
      {p.failed ? (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-body-sm text-red-700">
          <span className="material-symbols-outlined text-[18px]">error</span>
          <span>
            Previous lookup failed: <strong>{p.failed}</strong>. Adjust the details below and
            retry.
          </span>
        </div>
      ) : (
        <p className="text-body-sm text-on-surface-variant">
          Look up the patient&apos;s plan before opening a preauth. Stamps the claim&apos;s
          insurance correlation id so every chained NHCX call inherits it.
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="space-y-1.5">
          <span className={labelCls}>Payer code *</span>
          <input
            value={p.payerCode}
            onChange={(e) => p.setPayerCode(e.target.value)}
            placeholder="e.g. STAR_HEALTH"
            className="glass-input glass-input--sm font-mono"
          />
        </label>
        <label className="space-y-1.5">
          <span className={labelCls}>Payer display name</span>
          <input
            value={p.payerDisplayName}
            onChange={(e) => p.setPayerDisplayName(e.target.value)}
            placeholder="Star Health & Allied Insurance"
            className="glass-input glass-input--sm"
          />
        </label>
        <label className="space-y-1.5">
          <span className={labelCls}>Policy number *</span>
          <input
            value={p.policyNumber}
            onChange={(e) => p.setPolicyNumber(e.target.value)}
            placeholder="SHA-987654"
            className="glass-input glass-input--sm font-mono"
          />
        </label>
        <label className="space-y-1.5">
          <span className={labelCls}>Provider ID (HFR) *</span>
          <input
            value={p.providerId}
            onChange={(e) => p.setProviderId(e.target.value)}
            placeholder="IN1234567890"
            className="glass-input glass-input--sm font-mono"
          />
        </label>
      </div>
      <div className="flex justify-end">
        <button
          onClick={p.onSubmit}
          disabled={p.submitting}
          className="btn-primary"
          style={{ padding: '10px 22px', fontSize: '13px' }}
        >
          <span
            className="material-symbols-outlined text-[18px]"
            style={{ fontVariationSettings: "'FILL' 1" }}
          >
            search
          </span>
          {p.submitting ? 'Looking up…' : p.failed ? 'Retry lookup' : 'Look up plan'}
        </button>
      </div>
    </div>
  );
}

function PendingState({
  lookup,
  refreshing,
  onRefresh,
}: {
  lookup: InsurancePlanLookup;
  refreshing: boolean;
  onRefresh: () => void;
}): JSX.Element {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-body-sm text-amber-700">
        <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-amber-500" />
        Lookup acknowledged — waiting for the payer&apos;s{' '}
        <code className="rounded bg-white/70 px-1.5 py-0.5 font-mono text-[11px]">
          insuranceplan/on_request
        </code>{' '}
        callback.
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-body-sm">
        <KvField label="Payer" value={lookup.payerCode} mono />
        <KvField label="Policy" value={lookup.policyNumber} mono />
        <KvField label="Correlation id" value={lookup.correlationId} mono />
        <KvField label="Requested" value={new Date(lookup.requestedAt).toLocaleString()} />
      </dl>
      <div className="flex justify-end">
        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="btn-outline"
          style={{ padding: '8px 18px', fontSize: '13px' }}
        >
          <span className="material-symbols-outlined text-[18px]">refresh</span>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
    </div>
  );
}

function KvField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <div className="flex flex-col">
      <dt className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
        {label}
      </dt>
      <dd className={`text-on-surface ${mono ? 'font-mono text-body-sm' : ''}`}>{value}</dd>
    </div>
  );
}

function ResolvedState({
  lookup,
  refreshing,
  onRefresh,
}: {
  lookup: InsurancePlanLookup;
  refreshing: boolean;
  onRefresh: () => void;
}): JSX.Element {
  return (
    <div className="space-y-5">
      {/* Plan headline — teal-tinted card with left accent bar */}
      <div className="relative overflow-hidden rounded-lg border border-primary/10 bg-primary/5 p-5">
        <div className="absolute left-0 top-0 h-full w-1 bg-primary" />
        <div className="flex items-center gap-1 text-eyebrow uppercase tracking-eyebrow text-primary-container">
          <span
            className="material-symbols-outlined text-[14px]"
            style={{ fontVariationSettings: "'FILL' 1" }}
          >
            shield
          </span>
          {lookup.payerCode}
          {lookup.planType ? ` · ${lookup.planType}` : ''}
        </div>
        <h4 className="mt-1 text-h3 font-h3 text-on-primary-fixed-variant">
          {lookup.planName ?? 'Plan details available'}
        </h4>
        {lookup.sumInsuredPaise !== null ? (
          <div className="mt-1 text-body text-on-surface-variant">
            Sum insured{' '}
            <span className="font-semibold text-primary">
              {formatPaise(lookup.sumInsuredPaise)}
            </span>
          </div>
        ) : null}
      </div>

      {/* Detail grid */}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-body-sm sm:grid-cols-3">
        <Field label="Plan status" value={lookup.planStatus} />
        <Field label="Plan id" value={lookup.planId} mono />
        <Field label="Network" value={lookup.network} />
        <Field
          label="Coverage from"
          value={lookup.periodStart ? formatDate(lookup.periodStart) : null}
        />
        <Field
          label="Coverage to"
          value={lookup.periodEnd ? formatDate(lookup.periodEnd) : null}
        />
        <Field label="Policy" value={lookup.policyNumber} mono />
        <Field label="Correlation id" value={lookup.correlationId} mono />
        <Field
          label="Resolved"
          value={lookup.resolvedAt ? new Date(lookup.resolvedAt).toLocaleString() : null}
        />
        <Field label="Provider id" value={lookup.providerId} mono />
      </dl>

      <div className="flex justify-end">
        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="btn-outline"
          style={{ padding: '8px 18px', fontSize: '13px' }}
        >
          <span className="material-symbols-outlined text-[18px]">refresh</span>
          {refreshing ? 'Re-checking…' : 'Re-check'}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}): JSX.Element {
  return (
    <div className="space-y-0.5">
      <dt className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
        {label}
      </dt>
      <dd className={`text-on-surface ${mono ? 'font-mono text-body-sm' : 'text-body-sm'}`}>
        {value ?? '—'}
      </dd>
    </div>
  );
}

function formatPaise(paise: number): string {
  // Whole rupees when the amount is round; two decimals otherwise.
  const rupees = paise / 100;
  const isWhole = Number.isInteger(rupees);
  return `₹ ${rupees.toLocaleString('en-IN', {
    minimumFractionDigits: isWhole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
