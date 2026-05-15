'use client';

// Slice AM — web UI for the AL batch endpoint (Stitch-canonical layout).
//
// 12-col grid: CSV input + results table on the left (col-span-8),
// stat tiles on the right (col-span-4) showing Applied / Unmatched / Failed.

import {
  type RemittanceBatchResponse,
  type RemittanceMatchOutcome,
  type RemittanceRow,
} from '@claims/contracts';
import { useState } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { LumpSumAllocationPanel } from '../../../../components/remittance/LumpSumAllocationPanel';
import { RemittanceApi } from '../../../../lib/api/remittance.api';

const REQUIRED_COLS = ['claimRefNum', 'receivedAmount'] as const;
const OPTIONAL_COLS = ['receivedAt', 'bankTxnId', 'shortPaymentReasons'] as const;

interface ParseError {
  line: number;
  message: string;
}
interface ParseResult {
  rows: RemittanceRow[];
  errors: ParseError[];
}

function parseCsv(text: string): ParseResult {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { rows: [], errors: [] };
  const header = lines[0]!.split(',').map((c) => c.trim());
  const errors: ParseError[] = [];
  for (const required of REQUIRED_COLS) {
    if (!header.includes(required)) {
      errors.push({ line: 1, message: `Missing required column: ${required}` });
    }
  }
  if (errors.length > 0) return { rows: [], errors };

  const idx = (col: string): number => header.indexOf(col);
  const idxRef = idx('claimRefNum');
  const idxAmt = idx('receivedAmount');
  const idxAt = idx('receivedAt');
  const idxTxn = idx('bankTxnId');
  const idxReasons = idx('shortPaymentReasons');

  const rows: RemittanceRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const cols = lines[i]!.split(',').map((c) => c.trim());
    const ref = cols[idxRef] ?? '';
    if (!ref) {
      errors.push({ line: lineNo, message: 'Empty claimRefNum' });
      continue;
    }
    const amt = Number.parseInt(cols[idxAmt] ?? '', 10);
    if (!Number.isFinite(amt) || amt < 0) {
      errors.push({ line: lineNo, message: `Invalid receivedAmount: ${cols[idxAmt]}` });
      continue;
    }
    const row: RemittanceRow = { claimRefNum: ref, receivedAmount: amt };
    if (idxAt >= 0 && cols[idxAt]) row.receivedAt = cols[idxAt];
    if (idxTxn >= 0 && cols[idxTxn]) row.bankTxnId = cols[idxTxn];
    if (idxReasons >= 0 && cols[idxReasons]) {
      const reasons = cols[idxReasons]!
        .split(';')
        .map((r) => r.trim())
        .filter((r) => r.length > 0);
      if (reasons.length > 0) row.shortPaymentReasons = reasons;
    }
    rows.push(row);
  }
  return { rows, errors };
}

const OUTCOME_BADGE: Record<RemittanceMatchOutcome, { cls: string; dot: string }> = {
  applied: { cls: 'border-green-500/30 bg-green-500/10 text-green-700', dot: 'bg-green-500' },
  unmatched_no_claim: {
    cls: 'border-secondary-container/30 bg-secondary-container/10 text-secondary',
    dot: 'bg-secondary-container',
  },
  unmatched_no_settlement: {
    cls: 'border-secondary-container/30 bg-secondary-container/10 text-secondary',
    dot: 'bg-secondary-container',
  },
  failed: { cls: 'border-error/30 bg-error/10 text-error', dot: 'bg-error' },
};

export default function RemittanceBatchPage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const [csv, setCsv] = useState('');
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [response, setResponse] = useState<RemittanceBatchResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onParse = (): void => {
    const result = parseCsv(csv);
    setParsed(result);
    setResponse(null);
  };

  const onApply = async (): Promise<void> => {
    if (!parsed || parsed.rows.length === 0) return;
    setSubmitting(true);
    try {
      const r = await RemittanceApi.processBatch({ rows: parsed.rows });
      setResponse(r);
    } catch (err) {
      showApiError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6">
      {/* Header */}
      <section className="glass flex flex-col items-start justify-between gap-4 rounded-xl p-6 md:flex-row">
        <div>
          <h2 className="text-h2 font-h2 text-primary">Remittance batch</h2>
          <p className="mt-1 text-body text-on-surface-variant">
            Paste a CSV from the payer&apos;s daily remittance report to reconcile claims
            automatically.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 font-mono text-[11px] text-primary">
            <span className="h-1 w-1 rounded-full bg-primary" />
            required: {REQUIRED_COLS.join(', ')}
          </span>
          <span className="rounded-full border border-outline-variant/30 bg-surface-container-high px-3 py-1 font-mono text-[11px] text-on-surface-variant">
            optional: {OPTIONAL_COLS.join(', ')}
          </span>
        </div>
      </section>

      {/* T3-2 — lump-sum UTR allocation panel. Sits above the CSV
          batch flow because lump-sum is the more common operator
          workflow (bank deposits without per-claim breakdown). */}
      <LumpSumAllocationPanel />

      {/* 12-col grid */}
      <div className="grid grid-cols-12 gap-6">
        {/* Left column (col-span-8): input + results */}
        <div className="col-span-12 flex flex-col gap-6 lg:col-span-8">
          {/* CSV input */}
          <section className="glass flex flex-col gap-4 rounded-xl p-6">
            <div className="flex items-center justify-between">
              <span className="text-eyebrow uppercase tracking-eyebrow text-primary">
                CSV input
              </span>
              <span className="flex items-center gap-1 text-body-sm text-on-surface-variant">
                <span className="material-symbols-outlined text-[14px]">info</span>
                UTF-8 encoding supported
              </span>
            </div>
            <textarea
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              rows={10}
              placeholder={`claimRefNum,receivedAmount,receivedAt,bankTxnId,shortPaymentReasons\nSTUB-CL-12345,100000,2026-05-07T10:30:00Z,BANK-1,\nSTUB-CL-67890,75000,2026-05-07T10:30:00Z,BANK-2,Cap exceeded;Co-pay`}
              className="h-64 w-full resize-none rounded-xl border border-white/50 bg-white/40 p-4 font-mono text-body-sm text-on-surface outline-none transition-all focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
            <div className="mt-2 flex items-center justify-end gap-3">
              <button
                onClick={onParse}
                disabled={csv.trim().length === 0}
                className="flex items-center gap-2 rounded-full border border-primary/20 bg-white/30 px-6 py-2.5 font-semibold text-primary backdrop-blur-sm transition-all hover:bg-white/50 disabled:opacity-60"
              >
                <span className="material-symbols-outlined">data_object</span>
                Parse preview
              </button>
              <button
                onClick={() => void onApply()}
                disabled={
                  !parsed ||
                  parsed.rows.length === 0 ||
                  parsed.errors.length > 0 ||
                  submitting
                }
                className="btn-cta"
                style={{ padding: '12px 24px', fontSize: '13px' }}
              >
                <span
                  className="material-symbols-outlined"
                  style={{ fontSize: 18, fontVariationSettings: "'FILL' 1" }}
                >
                  upload_file
                </span>
                {submitting ? 'Applying…' : `Apply batch (${parsed?.rows.length ?? 0} rows)`}
              </button>
            </div>
          </section>

          {/* Parse errors */}
          {parsed && parsed.errors.length > 0 ? (
            <section
              className="glass rounded-xl p-6"
              style={{ background: 'rgba(255, 218, 214, 0.55)' }}
            >
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-error">error</span>
                <h3 className="text-eyebrow uppercase tracking-eyebrow text-error">
                  Parse errors
                </h3>
              </div>
              <ul className="mt-3 space-y-1 text-body-sm text-error">
                {parsed.errors.map((e, i) => (
                  <li key={i}>
                    <span className="font-mono">Line {e.line}</span> · {e.message}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* Preview table */}
          {parsed && parsed.rows.length > 0 && response === null ? (
            <section className="glass overflow-hidden rounded-xl">
              <div className="p-6 pb-0">
                <span className="mb-4 block text-eyebrow uppercase tracking-eyebrow text-primary">
                  Preview · {parsed.rows.length} rows
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left">
                  <thead className="bg-primary/5">
                    <tr>
                      <th className="px-6 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                        claimRefNum
                      </th>
                      <th className="px-6 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                        receivedAmount
                      </th>
                      <th className="px-6 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                        bankTxnId
                      </th>
                      <th className="px-6 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                        shortPaymentReasons
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/20">
                    {parsed.rows.map((r, i) => (
                      <tr key={i} className="transition-colors hover:bg-primary/5">
                        <td className="px-6 py-3 font-mono text-body-sm text-primary">
                          {r.claimRefNum}
                        </td>
                        <td className="px-6 py-3 text-body text-on-surface tabular-nums">
                          ₹{r.receivedAmount.toLocaleString('en-IN')}
                        </td>
                        <td className="px-6 py-3 font-mono text-body-sm text-on-surface-variant">
                          {r.bankTxnId ?? '—'}
                        </td>
                        <td className="px-6 py-3 text-body-sm text-on-surface-variant">
                          {r.shortPaymentReasons?.join('; ') ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {/* Result table */}
          {response ? (
            <section className="glass flex flex-col overflow-hidden rounded-xl">
              <div className="p-6 pb-0">
                <span className="mb-4 block text-eyebrow uppercase tracking-eyebrow text-primary">
                  Batch result
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left">
                  <thead className="bg-primary/5">
                    <tr>
                      <th className="px-6 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                        claimRefNum
                      </th>
                      <th className="px-6 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                        Outcome
                      </th>
                      <th className="px-6 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                        Reconciliation
                      </th>
                      <th className="px-6 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                        Error details
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/20">
                    {response.results.map((r, i) => {
                      const b = OUTCOME_BADGE[r.outcome];
                      return (
                        <tr key={i} className="transition-colors hover:bg-primary/5">
                          <td className="px-6 py-4 font-mono text-body-sm text-primary">
                            {r.claimRefNum}
                          </td>
                          <td className="px-6 py-4">
                            <span
                              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-bold uppercase ${b.cls}`}
                            >
                              <span className={`h-1.5 w-1.5 rounded-full ${b.dot}`} />
                              {r.outcome.replace(/_/g, ' ')}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-body-sm text-on-surface">
                            {r.reconciliationStatus ?? '—'}
                          </td>
                          <td className="px-6 py-4 text-body-sm font-medium text-error">
                            {r.error ?? '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </div>

        {/* Right column (col-span-4): stat tiles */}
        <div className="col-span-12 flex flex-col gap-6 lg:col-span-4">
          <StatTile
            label="Applied"
            value={response?.appliedCount ?? 0}
            tone="success"
            icon="check_circle"
            ping
          />
          <StatTile
            label="Unmatched"
            value={response?.unmatchedCount ?? 0}
            tone="warning"
            icon="search_off"
          />
          <StatTile
            label="Failed"
            value={response?.failedCount ?? 0}
            tone="danger"
            icon="error"
          />
          <StatTile
            label="Total rows"
            value={response?.totalRows ?? parsed?.rows.length ?? 0}
            tone="neutral"
            icon="list_alt"
          />
        </div>
      </div>
    </div>
  );
}

type Tone = 'success' | 'warning' | 'danger' | 'neutral';

const TONE_LIVE: Record<Tone, { dot: string; text: string }> = {
  success: { dot: 'bg-green-500', text: 'text-green-600' },
  warning: { dot: 'bg-secondary-container', text: 'text-secondary' },
  danger:  { dot: 'bg-error', text: 'text-error' },
  neutral: { dot: 'bg-outline', text: 'text-outline' },
};
const TONE_VALUE: Record<Tone, string> = {
  success: 'text-green-700',
  warning: 'text-secondary',
  danger: 'text-error',
  neutral: 'text-on-surface',
};
const TONE_ICON: Record<Tone, { bg: string; fg: string }> = {
  success: { bg: 'bg-green-500/10', fg: 'text-green-600' },
  warning: { bg: 'bg-secondary-container/10', fg: 'text-secondary' },
  danger:  { bg: 'bg-error/10', fg: 'text-error' },
  neutral: { bg: 'bg-surface-variant/40', fg: 'text-outline' },
};

interface StatTileProps {
  label: string;
  value: number;
  tone: Tone;
  icon: string;
  ping?: boolean;
}

function StatTile({ label, value, tone, icon, ping = false }: StatTileProps): JSX.Element {
  const live = TONE_LIVE[tone];
  const ic = TONE_ICON[tone];
  return (
    <div className="glass relative flex min-h-[140px] flex-col overflow-hidden rounded-xl p-6">
      <div className="mb-4 flex items-start justify-between">
        <span className={`flex items-center gap-1 text-eyebrow uppercase tracking-eyebrow ${live.text}`}>
          <span className="relative flex h-2 w-2">
            {ping ? (
              <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${live.dot} opacity-75`} />
            ) : null}
            <span className={`relative inline-flex h-2 w-2 rounded-full ${live.dot}`} />
          </span>
          Live
        </span>
        <div className={`flex h-8 w-8 items-center justify-center rounded-full ${ic.bg} ${ic.fg}`}>
          <span className="material-symbols-outlined text-[18px]">{icon}</span>
        </div>
      </div>
      <div className="mt-auto">
        <p className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">{label}</p>
        <h3 className={`text-h1 font-h1 tabular-nums ${TONE_VALUE[tone]}`}>
          {value.toString().padStart(2, '0')}
        </h3>
      </div>
    </div>
  );
}
