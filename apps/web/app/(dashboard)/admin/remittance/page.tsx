'use client';

import {
  type RemittanceBatchResponse,
  type RemittanceMatchOutcome,
  type RemittanceRow,
} from '@claims/contracts';
import { useState } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { RemittanceApi } from '../../../../lib/api/remittance.api';

// Slice AM — web UI for the AL batch endpoint.
//
// Operators paste a CSV from the bank's daily remittance report. Header
// row is required; columns are claimRefNum, receivedAmount, receivedAt,
// bankTxnId, shortPaymentReasons. shortPaymentReasons is semicolon-
// separated. The parser is intentionally simple — strict CSV (no
// embedded commas, no quoting); the operator can pre-clean if their
// payer's export is ugly. Sprint 5+ hardens with a real CSV parser if
// it becomes a problem.
const REQUIRED_COLS = [
  'claimRefNum',
  'receivedAmount',
] as const;
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

const OUTCOME_BADGE_COLOR: Record<RemittanceMatchOutcome, string> = {
  applied: 'bg-success-50 text-success-700 border-success-200',
  unmatched_no_claim: 'bg-warning-50 text-warning-700 border-warning-200',
  unmatched_no_settlement: 'bg-warning-50 text-warning-700 border-warning-200',
  failed: 'bg-error-50 text-error-700 border-error-200',
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
    <div className="space-y-6 rounded-md bg-neutral-0 p-8 shadow-md">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-800">Remittance batch</h1>
        <p className="text-sm text-neutral-500">
          Paste a CSV from the payer&apos;s daily remittance report.
          Required columns: <code>claimRefNum</code>, <code>receivedAmount</code>.
          Optional: <code>receivedAt</code> (ISO-8601), <code>bankTxnId</code>,
          <code>shortPaymentReasons</code> (semicolon-separated).
        </p>
        <p className="text-xs text-neutral-500">
          Required columns are <span className="font-mono">{REQUIRED_COLS.join(', ')}</span>;
          optional are <span className="font-mono">{OPTIONAL_COLS.join(', ')}</span>.
        </p>
      </header>

      <textarea
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
        rows={10}
        placeholder={`claimRefNum,receivedAmount,receivedAt,bankTxnId,shortPaymentReasons\nSTUB-CL-12345,100000,2026-05-07T10:30:00Z,BANK-1,\nSTUB-CL-67890,75000,2026-05-07T10:30:00Z,BANK-2,Cap exceeded;Co-pay`}
        className="w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 font-mono text-xs focus:border-primary-500 focus:outline-none"
      />

      <div className="flex gap-2">
        <button
          onClick={onParse}
          disabled={csv.trim().length === 0}
          className="rounded-sm border border-neutral-300 bg-neutral-0 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-60"
        >
          Parse preview
        </button>
        <button
          onClick={() => void onApply()}
          disabled={!parsed || parsed.rows.length === 0 || parsed.errors.length > 0 || submitting}
          className="rounded-sm bg-primary-600 px-3 py-2 text-sm font-medium text-neutral-0 hover:bg-primary-700 disabled:opacity-60"
        >
          {submitting ? 'Applying…' : `Apply batch (${parsed?.rows.length ?? 0} rows)`}
        </button>
      </div>

      {parsed && parsed.errors.length > 0 ? (
        <section className="space-y-2 rounded-sm border border-error-200 bg-error-50 p-3">
          <h2 className="text-sm font-semibold text-error-700">Parse errors</h2>
          <ul className="space-y-1 text-xs text-error-700">
            {parsed.errors.map((e, i) => (
              <li key={i}>
                Line {e.line}: {e.message}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {parsed && parsed.rows.length > 0 && response === null ? (
        <section className="space-y-2 rounded-sm border border-neutral-200 p-3">
          <h2 className="text-sm font-semibold text-neutral-700">
            Preview ({parsed.rows.length} rows)
          </h2>
          <table className="min-w-full text-xs">
            <thead className="text-neutral-500">
              <tr>
                <th className="text-left font-medium">claimRefNum</th>
                <th className="text-left font-medium">receivedAmount</th>
                <th className="text-left font-medium">bankTxnId</th>
                <th className="text-left font-medium">shortPaymentReasons</th>
              </tr>
            </thead>
            <tbody>
              {parsed.rows.map((r, i) => (
                <tr key={i} className="border-t border-neutral-100">
                  <td className="py-1 font-mono">{r.claimRefNum}</td>
                  <td className="py-1">{r.receivedAmount}</td>
                  <td className="py-1 font-mono">{r.bankTxnId ?? '—'}</td>
                  <td className="py-1">{r.shortPaymentReasons?.join('; ') ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {response ? (
        <section className="space-y-3 rounded-sm border border-neutral-200 p-3">
          <header className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-700">Batch result</h2>
            <span className="text-xs text-neutral-500">
              {response.appliedCount} applied · {response.unmatchedCount} unmatched ·
              {' '}
              {response.failedCount} failed · {response.totalRows} total
            </span>
          </header>
          <table className="min-w-full text-xs">
            <thead className="text-neutral-500">
              <tr>
                <th className="text-left font-medium">claimRefNum</th>
                <th className="text-left font-medium">outcome</th>
                <th className="text-left font-medium">reconciliation</th>
                <th className="text-left font-medium">error</th>
              </tr>
            </thead>
            <tbody>
              {response.results.map((r, i) => (
                <tr key={i} className="border-t border-neutral-100">
                  <td className="py-1 font-mono">{r.claimRefNum}</td>
                  <td className="py-1">
                    <span
                      className={`inline-block rounded-sm border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${OUTCOME_BADGE_COLOR[r.outcome]}`}
                    >
                      {r.outcome.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className="py-1">{r.reconciliationStatus ?? '—'}</td>
                  <td className="py-1 text-error-700">{r.error ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}
