'use client';

// T2-13 — non-medical auto-strip calculator.
//
// Operator-aid only. Operator pastes a hospital bill (one line per
// row, "description \t amount" or "description, amount"), the
// component POSTs to /discharge/classify-non-medical, and renders:
//   - per-line tagging (medical or non-medical / category)
//   - totals (medical / non-medical / grand total)
//   - by-category breakdown
//
// Nothing is persisted; the operator decides what finalAmount to type
// into the ClaimPhasePanel below. Default behaviour suggests
// finalAmount = grandTotal − nonMedical so the claim only includes
// reimbursable items.

import {
  type BillLine,
  type ClassifyNonMedicalResponse,
  type NonMedicalCategory,
} from '@claims/contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { DischargeApi } from '../../lib/api/discharge.api';
import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';

const CATEGORY_LABEL: Record<NonMedicalCategory, string> = {
  toiletries: 'Toiletries',
  attendant_food: 'Attendant food',
  attendant_stay: 'Attendant stay',
  admin_fees: 'Admin / fees',
  transport: 'Transport',
  comfort: 'Comfort / amenity',
  documentation: 'Documentation',
  miscellaneous_consumables: 'Misc. consumables',
  miscellaneous: 'Miscellaneous',
};

const PLACEHOLDER = `Room rent — single AC\t8000
Surgery\t45000
Toiletry kit\t300
Attendant food (3 days)\t900
TV rental\t150
Medical record copy\t200`;

function parseRowsToLines(raw: string): BillLine[] {
  // Each row: split on tab OR last run of whitespace OR comma. Last
  // numeric token is the amount; everything before is the description.
  const out: BillLine[] = [];
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // Find the last number in the line as the amount.
    const m = line.match(/^(.+?)[\t,\s]+([0-9][0-9,.\s]*)\s*$/);
    if (!m) continue;
    const desc = (m[1] ?? '').trim();
    const amountStr = (m[2] ?? '').replace(/[,\s]/g, '');
    const rupees = Number(amountStr);
    if (!Number.isFinite(rupees) || rupees < 0 || !desc) continue;
    out.push({ description: desc, amountPaise: Math.round(rupees * 100) });
  }
  return out;
}

function fmtINR(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export function NonMedicalStripCalculator(): JSX.Element {
  const { showApiError } = useErrorModal();
  const [text, setText] = useState('');
  const [result, setResult] = useState<ClassifyNonMedicalResponse | null>(null);
  const [classifying, setClassifying] = useState(false);

  const lines = useMemo(() => parseRowsToLines(text), [text]);

  const classify = useCallback(async () => {
    if (lines.length === 0) {
      setResult(null);
      return;
    }
    setClassifying(true);
    try {
      const res = await DischargeApi.classifyNonMedical({ lines });
      setResult(res);
    } catch (err) {
      showApiError(err);
    } finally {
      setClassifying(false);
    }
  }, [lines, showApiError]);

  // Debounced classify-on-edit. 400ms is enough that the operator
  // can finish typing the amount before the request fires; short
  // enough that the result feels live.
  useEffect(() => {
    const id = setTimeout(() => void classify(), 400);
    return () => clearTimeout(id);
  }, [classify]);

  const suggestedFinal = useMemo(() => {
    if (!result) return null;
    return result.totals.grandTotalPaise - result.totals.nonMedicalPaise;
  }, [result]);

  return (
    <section className="glass space-y-4 rounded-xl p-6">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-primary">receipt_long</span>
        <h3 className="text-h3 font-h3 text-on-surface">Bill classifier (T2-13)</h3>
      </div>
      <p className="text-body-sm text-on-surface-variant">
        Paste the hospital bill (one line per row, tab- or comma-separated
        description and rupee amount). Non-medical items the payer will
        strip on the EOB are flagged here so you can decide what to enter
        as the final claim amount below. Nothing is persisted &mdash; this
        is an operator aid.
      </p>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        placeholder={PLACEHOLDER}
        className="w-full rounded-lg border border-white bg-surface-container-lowest/50 px-4 py-3 font-mono text-body-sm text-on-surface placeholder:text-outline-variant shadow-sm outline-none transition-all focus:border-primary-container focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary-container"
      />

      <div className="flex items-center justify-between text-body-sm text-on-surface-variant">
        <span>
          {lines.length} line{lines.length === 1 ? '' : 's'} parsed
          {classifying ? ' · classifying…' : ''}
        </span>
        {text.trim().length === 0 ? (
          <button
            type="button"
            onClick={() => setText(PLACEHOLDER)}
            className="text-primary hover:underline"
          >
            Load sample
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              setText('');
              setResult(null);
            }}
            className="text-on-surface-variant hover:text-primary"
          >
            Clear
          </button>
        )}
      </div>

      {result ? (
        <>
          {/* Summary tiles */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <SummaryTile
              label="Medical total"
              value={fmtINR(result.totals.medicalPaise)}
              tone="primary"
            />
            <SummaryTile
              label="Non-medical (strip)"
              value={fmtINR(result.totals.nonMedicalPaise)}
              tone={result.totals.nonMedicalPaise > 0 ? 'amber' : 'neutral'}
            />
            <SummaryTile
              label="Grand total"
              value={fmtINR(result.totals.grandTotalPaise)}
            />
            <SummaryTile
              label="Suggested final"
              value={suggestedFinal !== null ? fmtINR(suggestedFinal) : '—'}
              tone="primary"
              hint="= grand total − non-medical"
            />
          </div>

          {/* By-category */}
          {result.byCategory.length > 0 ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-4">
              <p className="mb-3 text-eyebrow uppercase tracking-eyebrow text-amber-700">
                Non-medical by category
              </p>
              <ul className="space-y-1 text-body-sm">
                {result.byCategory.map((row) => (
                  <li
                    key={row.category}
                    className="flex items-center justify-between gap-3 font-mono tabular-nums text-on-surface"
                  >
                    <span className="text-on-surface-variant">
                      {CATEGORY_LABEL[row.category]} · {row.count} line
                      {row.count === 1 ? '' : 's'}
                    </span>
                    <span className="font-medium">{fmtINR(row.amountPaise)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* Per-line table */}
          <div className="overflow-x-auto rounded-lg border border-outline-variant/30">
            <table className="w-full border-collapse text-left text-body-sm">
              <thead className="bg-surface-container-low/40">
                <tr>
                  <th className="px-3 py-2 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                    Line item
                  </th>
                  <th className="px-3 py-2 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                    Classification
                  </th>
                  <th className="px-3 py-2 text-right text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.lines.map((line, idx) => (
                  <tr
                    key={idx}
                    className={
                      line.medical
                        ? 'border-t border-outline-variant/20'
                        : 'border-t border-outline-variant/20 bg-amber-50/40'
                    }
                  >
                    <td className="px-3 py-2 text-on-surface">{line.description}</td>
                    <td className="px-3 py-2 text-on-surface-variant">
                      {line.medical ? (
                        <span className="inline-flex items-center gap-1 text-primary">
                          <span className="material-symbols-outlined text-[14px]">
                            check_circle
                          </span>
                          Medical
                        </span>
                      ) : (
                        <span className="inline-flex flex-wrap items-center gap-1 text-amber-700">
                          <span className="material-symbols-outlined text-[14px]">block</span>
                          {line.category ? CATEGORY_LABEL[line.category] : 'Non-medical'}
                          {line.matchedTerm ? (
                            <span className="text-[10px] text-amber-700/70">
                              · matched &ldquo;{line.matchedTerm}&rdquo;
                            </span>
                          ) : null}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-on-surface">
                      {fmtINR(line.amountPaise)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

function SummaryTile({
  label,
  value,
  tone = 'neutral',
  hint,
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'primary' | 'amber';
  hint?: string;
}): JSX.Element {
  const valCls =
    tone === 'primary'
      ? 'text-primary'
      : tone === 'amber'
        ? 'text-amber-700'
        : 'text-on-surface';
  return (
    <div className="rounded-lg border border-outline-variant/30 bg-surface-container-lowest/50 p-3">
      <p className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">{label}</p>
      <p className={`mt-1 font-mono text-h3 font-bold tabular-nums ${valCls}`}>{value}</p>
      {hint ? (
        <p className="mt-1 text-[10px] text-on-surface-variant">{hint}</p>
      ) : null}
    </div>
  );
}
