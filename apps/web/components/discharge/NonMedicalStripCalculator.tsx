'use client';

// T2-13 — non-medical auto-strip calculator + bill line item persistence.
//
// Two modes keyed off `claimId`:
//
//   * Stateless (claimId omitted / null):
//       Pure operator aid. Textarea → debounced classify-on-edit
//       POST to /discharge/classify-non-medical. Nothing persists.
//       Original behaviour from PR #113.
//
//   * Persistent (claimId set):
//       On mount, GET /cases/.../bill-line-items and pre-populate
//       the textarea from any previously-saved bill. "Save to
//       claim" button POSTs the current classified set to the
//       same endpoint (replace-all semantics). A "saved · N lines"
//       indicator shows the last persisted state.
//
// The classifier still runs locally on every textarea edit so the
// operator sees the strip math live; persistence is opt-in via a
// click so we don't write to the DB on every keystroke.
//
// The default behaviour in both modes suggests
// `finalAmount = grandTotal − nonMedical` so the claim only
// includes reimbursable items. The operator still types the
// number into ClaimPhasePanel below.

import {
  type BillLine,
  type ClassifiedLine,
  type ClassifyNonMedicalResponse,
  type NonMedicalCategory,
  type SaveBillLineItem,
} from '@claims/contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { BillLineItemApi } from '../../lib/api/bill-line-item.api';
import { DischargeApi } from '../../lib/api/discharge.api';
import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';

interface Props {
  // Both optional so the component still works as a standalone
  // operator aid (PR #113 behaviour). Provide both to enable
  // persistence.
  caseId?: string;
  claimId?: string | null;
}

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

function classifiedToText(
  lines: Array<{ description: string; amountPaise: number }>,
): string {
  return lines
    .map(
      (l) =>
        `${l.description}\t${(l.amountPaise / 100).toLocaleString('en-IN', {
          maximumFractionDigits: 0,
          useGrouping: false,
        })}`,
    )
    .join('\n');
}

function classifiedToSavePayload(lines: ClassifiedLine[]): SaveBillLineItem[] {
  return lines.map((l) => ({
    description: l.description,
    amountPaise: l.amountPaise,
    medical: l.medical,
    ...(l.medical ? {} : { category: l.category ?? null, matchedTerm: l.matchedTerm }),
  }));
}

function fmtINR(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function NonMedicalStripCalculator({ caseId, claimId }: Props = {}): JSX.Element {
  const { showApiError } = useErrorModal();
  const [text, setText] = useState('');
  const [result, setResult] = useState<ClassifyNonMedicalResponse | null>(null);
  const [classifying, setClassifying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [savedLineCount, setSavedLineCount] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);

  const persistEnabled = Boolean(caseId && claimId);

  // Mount-time load when persistence is enabled. We pre-populate
  // the textarea from any previously-saved rows so the operator
  // resumes where they left off.
  useEffect(() => {
    if (!persistEnabled || !caseId || !claimId) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await BillLineItemApi.list(caseId, claimId);
        if (cancelled) return;
        if (res.lines.length > 0) {
          setText(classifiedToText(res.lines));
          setSavedAt(res.lines[res.lines.length - 1]?.createdAt ?? null);
          setSavedLineCount(res.lines.length);
        }
      } catch (err) {
        if (!cancelled) showApiError(err);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [persistEnabled, caseId, claimId, showApiError]);

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

  const onSave = useCallback(async () => {
    if (!persistEnabled || !caseId || !claimId || !result) return;
    setSaving(true);
    try {
      const out = await BillLineItemApi.save(caseId, claimId, {
        lines: classifiedToSavePayload(result.lines),
      });
      const lastCreatedAt = out.lines[out.lines.length - 1]?.createdAt;
      setSavedAt(lastCreatedAt ?? new Date().toISOString());
      setSavedLineCount(out.lines.length);
    } catch (err) {
      showApiError(err);
    } finally {
      setSaving(false);
    }
  }, [persistEnabled, caseId, claimId, result, showApiError]);

  const suggestedFinal = useMemo(() => {
    if (!result) return null;
    return result.totals.grandTotalPaise - result.totals.nonMedicalPaise;
  }, [result]);

  const canSave =
    persistEnabled &&
    result !== null &&
    result.lines.length > 0 &&
    !saving &&
    !classifying;

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
        as the final claim amount below.
        {persistEnabled ? (
          <>
            {' '}Click &ldquo;Save to claim&rdquo; to persist the classified bill
            against this claim for later EOB-line reconciliation.
          </>
        ) : (
          <> Nothing is persisted &mdash; this is an operator aid.</>
        )}
      </p>

      {persistEnabled && !loaded ? (
        <p className="text-body-sm text-on-surface-variant">Loading saved bill…</p>
      ) : null}

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        placeholder={PLACEHOLDER}
        className="w-full rounded-lg border border-white bg-surface-container-lowest/50 px-4 py-3 font-mono text-body-sm text-on-surface placeholder:text-outline-variant shadow-sm outline-none transition-all focus:border-primary-container focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary-container"
      />

      <div className="flex flex-wrap items-center justify-between gap-3 text-body-sm text-on-surface-variant">
        <span>
          {lines.length} line{lines.length === 1 ? '' : 's'} parsed
          {classifying ? ' · classifying…' : ''}
          {savedAt !== null && savedLineCount !== null ? (
            <span className="ml-2 text-on-surface-variant">
              · saved {savedLineCount} line{savedLineCount === 1 ? '' : 's'}{' '}
              at {fmtTime(savedAt)}
            </span>
          ) : null}
        </span>
        <div className="flex items-center gap-3">
          {persistEnabled ? (
            <button
              type="button"
              onClick={() => void onSave()}
              disabled={!canSave}
              className="btn-primary"
              style={{ padding: '8px 14px', fontSize: '12px' }}
            >
              <span
                className="material-symbols-outlined"
                style={{ fontSize: 16, fontVariationSettings: "'FILL' 1" }}
              >
                save
              </span>
              {saving ? 'Saving…' : 'Save to claim'}
            </button>
          ) : null}
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
