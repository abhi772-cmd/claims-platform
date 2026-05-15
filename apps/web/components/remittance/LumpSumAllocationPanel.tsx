'use client';

import {
  type LumpSumAllocateResponse,
  type RemittanceCandidate,
} from '@claims/contracts';
import { useState, type ChangeEvent } from 'react';

import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';
import { RemittanceApi } from '../../lib/api/remittance.api';

// T3-2 — lump-sum UTR allocation panel.
//
// Flow on this panel:
//   1. Operator pastes the bank's UTR + total amount + (optional)
//      payerCode.
//   2. Clicks "Suggest claims" → fetches /candidates and shows open
//      settlements for that payer.
//   3. Operator picks N candidates + assigns per-claim amounts. The
//      banner shows live sum vs total; the apply button stays disabled
//      until they match.
//   4. Clicks "Allocate UTR" → POST /lump-sum, render per-claim outcome.
//
// Visual language matches the rest of the admin/remittance page:
// glass cards, teal primary + amber accent, sentence case.

interface AllocationDraft {
  claimId: string;
  allocatedAmount: string; // string so the input is controllable
}

function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function parseRupeesToPaise(value: string): number {
  if (!value.trim()) return 0;
  const cleaned = value.replace(/[^0-9.]/g, '');
  const asFloat = Number.parseFloat(cleaned);
  if (Number.isNaN(asFloat)) return 0;
  return Math.round(asFloat * 100);
}

export function LumpSumAllocationPanel(): JSX.Element {
  const { showApiError } = useErrorModal();
  const [bankTxnId, setBankTxnId] = useState('');
  const [totalRupees, setTotalRupees] = useState('');
  const [payerCode, setPayerCode] = useState('');
  const [candidates, setCandidates] = useState<RemittanceCandidate[]>([]);
  const [allocations, setAllocations] = useState<Record<string, AllocationDraft>>({});
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [response, setResponse] = useState<LumpSumAllocateResponse | null>(null);

  const totalPaise = parseRupeesToPaise(totalRupees);
  const selectedClaims = Object.values(allocations);
  const allocatedPaise = selectedClaims.reduce(
    (acc, a) => acc + parseRupeesToPaise(a.allocatedAmount),
    0,
  );
  const remainingPaise = totalPaise - allocatedPaise;
  const canSubmit =
    bankTxnId.trim().length > 0 &&
    totalPaise > 0 &&
    selectedClaims.length > 0 &&
    remainingPaise === 0 &&
    !submitting;

  async function loadCandidates(): Promise<void> {
    setLoading(true);
    setResponse(null);
    try {
      const res = await RemittanceApi.candidates({
        ...(payerCode.trim() ? { payerCode: payerCode.trim() } : {}),
        limit: 100,
      });
      setCandidates(res.candidates);
      setAllocations({});
    } catch (err) {
      showApiError(err);
    } finally {
      setLoading(false);
    }
  }

  function togglePick(c: RemittanceCandidate): void {
    setAllocations((prev) => {
      const next = { ...prev };
      if (next[c.claimId]) {
        delete next[c.claimId];
      } else {
        // Default per-claim amount: the remaining expected (paise) on
        // the settlement; converted to rupees for the input.
        const remainingExpected = Math.max(
          0,
          c.expectedAmount - (c.currentReceivedAmount ?? 0),
        );
        next[c.claimId] = {
          claimId: c.claimId,
          allocatedAmount: (remainingExpected / 100).toFixed(2),
        };
      }
      return next;
    });
  }

  function setAllocationAmount(claimId: string, value: string): void {
    setAllocations((prev) => ({
      ...prev,
      [claimId]: { claimId, allocatedAmount: value },
    }));
  }

  async function onAllocate(): Promise<void> {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const res = await RemittanceApi.allocateLumpSum({
        bankTxnId: bankTxnId.trim(),
        totalAmount: totalPaise,
        ...(payerCode.trim() ? { payerCode: payerCode.trim() } : {}),
        allocations: selectedClaims.map((a) => ({
          claimId: a.claimId,
          allocatedAmount: parseRupeesToPaise(a.allocatedAmount),
        })),
      });
      setResponse(res);
    } catch (err) {
      showApiError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="glass flex flex-col gap-5 rounded-xl p-6">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-primary">account_balance</span>
        <h3 className="text-h3 font-h3 text-on-surface">Lump-sum UTR allocation</h3>
      </div>
      <p className="text-body-sm text-on-surface-variant">
        One bank deposit covering multiple claims with no per-claim breakdown?
        Paste the UTR, pull candidates, then split the total across the matching
        settlements.
      </p>

      {/* Header inputs */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <LabeledInput
          label="Bank UTR / txn ref"
          value={bankTxnId}
          onChange={(e) => setBankTxnId(e.target.value)}
          placeholder="HDFC0123XYZ"
          mono
        />
        <LabeledInput
          label="Total received (₹)"
          value={totalRupees}
          onChange={(e) => setTotalRupees(e.target.value)}
          placeholder="300000.00"
          mono
        />
        <LabeledInput
          label="Payer code (optional)"
          value={payerCode}
          onChange={(e) => setPayerCode(e.target.value)}
          placeholder="MEDIASSIST"
          mono
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          onClick={() => void loadCandidates()}
          disabled={loading}
          className="flex items-center gap-2 rounded-full border border-primary/20 bg-white/30 px-5 py-2.5 font-semibold text-primary transition-all hover:bg-white/50 disabled:opacity-60"
        >
          <span className="material-symbols-outlined">search</span>
          {loading ? 'Loading…' : 'Suggest claims'}
        </button>
        <AllocationBanner
          totalPaise={totalPaise}
          allocatedPaise={allocatedPaise}
          remainingPaise={remainingPaise}
          claimCount={selectedClaims.length}
        />
      </div>

      {/* Candidate table */}
      {candidates.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-outline-variant/30">
          <table className="w-full border-collapse text-left">
            <thead className="bg-primary/5">
              <tr>
                <th className="px-4 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                  Pick
                </th>
                <th className="px-4 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                  Patient
                </th>
                <th className="px-4 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                  Claim ref
                </th>
                <th className="px-4 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                  Payer
                </th>
                <th className="px-4 py-3 text-right text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                  Expected
                </th>
                <th className="px-4 py-3 text-right text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                  Already received
                </th>
                <th className="px-4 py-3 text-right text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                  Allocate (₹)
                </th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => {
                const picked = Boolean(allocations[c.claimId]);
                return (
                  <tr key={c.claimId} className="border-t border-outline-variant/20">
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={picked}
                        onChange={() => togglePick(c)}
                        className="h-4 w-4 accent-primary"
                      />
                    </td>
                    <td className="px-4 py-3 text-body-sm text-on-surface">
                      {c.patientName}
                    </td>
                    <td className="px-4 py-3 font-mono text-body-sm text-on-surface-variant">
                      {c.claimRefNum ?? '—'}
                    </td>
                    <td className="px-4 py-3 font-mono text-body-sm text-on-surface-variant">
                      {c.payerCode ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-body-sm tabular-nums text-on-surface">
                      {rupees(c.expectedAmount)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-body-sm tabular-nums text-on-surface-variant">
                      {c.currentReceivedAmount !== null
                        ? rupees(c.currentReceivedAmount)
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {picked ? (
                        <input
                          type="text"
                          inputMode="decimal"
                          value={allocations[c.claimId]?.allocatedAmount ?? ''}
                          onChange={(e) =>
                            setAllocationAmount(c.claimId, e.target.value)
                          }
                          className="w-32 rounded-lg border border-outline-variant/40 bg-white/60 px-3 py-1.5 text-right font-mono text-body-sm tabular-nums focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                        />
                      ) : (
                        <span className="text-body-sm text-outline">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* Submit */}
      <div className="flex items-center justify-end">
        <button
          onClick={() => void onAllocate()}
          disabled={!canSubmit}
          className="btn-cta"
          style={{ padding: '12px 24px', fontSize: '13px' }}
        >
          <span
            className="material-symbols-outlined"
            style={{ fontSize: 18, fontVariationSettings: "'FILL' 1" }}
          >
            paid
          </span>
          {submitting
            ? 'Allocating…'
            : `Allocate UTR (${selectedClaims.length} claims)`}
        </button>
      </div>

      {/* Result summary */}
      {response ? (
        <section className="rounded-xl border border-outline-variant/30 bg-white/30 p-5">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">task_alt</span>
            <h4 className="text-eyebrow uppercase tracking-eyebrow text-primary">
              Allocation complete
            </h4>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 text-body-sm text-on-surface md:grid-cols-4">
            <Stat label="UTR" value={response.bankTxnId} mono />
            <Stat label="Total" value={rupees(response.totalAmount)} mono />
            <Stat label="Applied" value={String(response.appliedCount)} />
            <Stat label="Failed" value={String(response.failedCount)} />
          </div>
          {response.failedCount > 0 ? (
            <ul className="mt-4 space-y-1 text-body-sm text-error">
              {response.results
                .filter((r) => r.outcome === 'failed')
                .map((r) => (
                  <li key={r.claimId}>
                    <span className="font-mono">{r.claimId.slice(0, 8)}</span>{' '}
                    · {r.error ?? 'unknown error'}
                  </li>
                ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}

function LabeledInput(props: {
  label: string;
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
        {props.label}
      </span>
      <input
        type="text"
        value={props.value}
        onChange={props.onChange}
        placeholder={props.placeholder}
        className={`rounded-lg border border-outline-variant/40 bg-white/40 px-4 py-2.5 text-body-sm text-on-surface placeholder:text-outline focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 ${
          props.mono ? 'font-mono tabular-nums' : ''
        }`}
      />
    </label>
  );
}

function AllocationBanner(props: {
  totalPaise: number;
  allocatedPaise: number;
  remainingPaise: number;
  claimCount: number;
}): JSX.Element {
  const balanced = props.totalPaise > 0 && props.remainingPaise === 0;
  return (
    <div
      className={`flex items-center gap-3 rounded-full px-4 py-2 text-body-sm ${
        balanced
          ? 'border border-primary/30 bg-primary/10 text-primary'
          : 'border border-outline-variant/30 bg-surface-container-high text-on-surface'
      }`}
    >
      <span className="font-medium">
        {props.claimCount} {props.claimCount === 1 ? 'claim picked' : 'claims picked'}
      </span>
      <span className="font-mono tabular-nums">
        {rupees(props.allocatedPaise)} / {rupees(props.totalPaise)}
      </span>
      {balanced ? (
        <span className="material-symbols-outlined text-[18px]">check_circle</span>
      ) : (
        <span className="text-body-sm">
          {props.remainingPaise > 0 ? 'short' : 'over'} by{' '}
          <span className="font-mono tabular-nums">
            {rupees(Math.abs(props.remainingPaise))}
          </span>
        </span>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <div>
      <p className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
        {label}
      </p>
      <p
        className={`mt-0.5 text-body text-on-surface ${mono ? 'font-mono tabular-nums' : ''}`}
      >
        {value}
      </p>
    </div>
  );
}
