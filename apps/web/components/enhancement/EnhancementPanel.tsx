'use client';

// T2-8 — preauth enhancement panel. Five visible states keyed off
// the claim's current status:
//
//   PREAUTH_APPROVED / PREAUTH_PARTIALLY_APPROVED
//     → "Start enhancement" CTA. Calls /enhancement/start, which
//        flips status to ENHANCEMENT_DRAFTING.
//
//   ENHANCEMENT_DRAFTING
//     → revised-amount + reason form. On submit, calls
//        /enhancement/submit which flips status all the way to
//        ENHANCEMENT_SUBMITTED via ENHANCEMENT_QUEUED (in stub mode;
//        in real mode the inbound callback finishes the trip).
//
//   ENHANCEMENT_QUEUED / ENHANCEMENT_SUBMITTED
//     → "Awaiting payer decision" status display.
//
//   ENHANCEMENT_APPROVED / ENHANCEMENT_REJECTED
//     → Terminal status display.
//
//   Anything else: panel renders nothing. The parent page (case
//   detail) gates on `claim` being present before mounting.

import { type ClaimStatus } from '@claims/contracts';
import { useState, type FormEvent } from 'react';

import { EnhancementApi } from '../../lib/api/enhancement.api';
import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';

interface Props {
  caseId: string;
  claimId: string;
  status: ClaimStatus;
  // Operator hint: previously approved preauth amount in paise.
  // Used to pre-fill the revised-amount input. Optional; falls
  // back to a blank input when null.
  priorPreauthAmount: number | null;
  // Operator hint: suggested top-up in paise (e.g. computed from
  // currentRoomDailyRate − roomDailyRate × remainingStayDays).
  // The component just adds this to priorPreauthAmount as the
  // pre-filled default — operator can override.
  suggestedTopUpPaise?: number | null;
  onChanged: () => void;
}

type Phase =
  | 'eligible_to_start'   // PREAUTH_APPROVED / PREAUTH_PARTIALLY_APPROVED
  | 'drafting'            // ENHANCEMENT_DRAFTING
  | 'awaiting_decision'   // ENHANCEMENT_QUEUED / ENHANCEMENT_SUBMITTED
  | 'terminal'            // ENHANCEMENT_APPROVED / ENHANCEMENT_REJECTED
  | 'hidden';

function phaseOf(status: ClaimStatus): Phase {
  if (status === 'PREAUTH_APPROVED' || status === 'PREAUTH_PARTIALLY_APPROVED') {
    return 'eligible_to_start';
  }
  if (status === 'ENHANCEMENT_DRAFTING') return 'drafting';
  if (status === 'ENHANCEMENT_QUEUED' || status === 'ENHANCEMENT_SUBMITTED') {
    return 'awaiting_decision';
  }
  if (status === 'ENHANCEMENT_APPROVED' || status === 'ENHANCEMENT_REJECTED') {
    return 'terminal';
  }
  return 'hidden';
}

function fmtINR(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export function EnhancementPanel({
  caseId,
  claimId,
  status,
  priorPreauthAmount,
  suggestedTopUpPaise,
  onChanged,
}: Props): JSX.Element | null {
  const { showApiError } = useErrorModal();
  const phase = phaseOf(status);
  const [working, setWorking] = useState(false);
  const defaultRevisedRupees = (() => {
    if (priorPreauthAmount === null) return '';
    const topUp = suggestedTopUpPaise && suggestedTopUpPaise > 0 ? suggestedTopUpPaise : 0;
    return Math.round((priorPreauthAmount + topUp) / 100).toString();
  })();
  const [revisedRupees, setRevisedRupees] = useState(defaultRevisedRupees);
  const [reason, setReason] = useState('ICU upgrade — additional preauth requested');

  if (phase === 'hidden') return null;

  const onStart = async (): Promise<void> => {
    setWorking(true);
    try {
      await EnhancementApi.start(caseId, claimId);
      onChanged();
    } catch (err) {
      showApiError(err);
    } finally {
      setWorking(false);
    }
  };

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const rupees = Number(revisedRupees);
    if (!Number.isFinite(rupees) || rupees <= 0) return;
    const trimmed = reason.trim();
    if (trimmed.length === 0) return;
    setWorking(true);
    try {
      await EnhancementApi.submit(caseId, claimId, {
        revisedAmount: Math.round(rupees * 100),
        reason: trimmed,
      });
      onChanged();
    } catch (err) {
      showApiError(err);
    } finally {
      setWorking(false);
    }
  };

  return (
    <section className="glass space-y-4 rounded-xl p-6">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-primary">trending_up</span>
        <h3 className="text-h3 font-h3 text-on-surface">Pre-auth enhancement (T2-8)</h3>
      </div>

      {phase === 'eligible_to_start' ? (
        <>
          <p className="text-body-sm text-on-surface-variant">
            The preauth has been approved. Use this if the patient was moved
            to a higher-tier ward (typically ICU) and the original approved
            amount is no longer sufficient. The hospital submits a follow-up
            preauth referencing the prior approval; the payer decisions on
            the enhancement separately.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void onStart()}
              disabled={working}
              className="btn-cta"
              style={{ padding: '12px 24px', fontSize: '13px' }}
            >
              <span
                className="material-symbols-outlined"
                style={{ fontSize: 18, fontVariationSettings: "'FILL' 1" }}
              >
                add_circle
              </span>
              {working ? 'Starting…' : 'Start enhancement'}
            </button>
            {priorPreauthAmount !== null ? (
              <span className="text-body-sm text-on-surface-variant">
                Prior approved amount:{' '}
                <span className="font-mono font-medium text-on-surface">
                  {fmtINR(priorPreauthAmount)}
                </span>
              </span>
            ) : null}
          </div>
        </>
      ) : null}

      {phase === 'drafting' ? (
        <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
          <p className="text-body-sm text-on-surface-variant">
            Enter the new TOTAL requested amount (not the delta) and a
            short justification. The justification is surfaced to the
            payer.
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label
                htmlFor="enh-amount"
                className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant"
              >
                Revised total amount (₹)
              </label>
              <input
                id="enh-amount"
                inputMode="numeric"
                value={revisedRupees}
                onChange={(e) => setRevisedRupees(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="e.g. 150000"
                className="w-full rounded-lg border border-white bg-surface-container-lowest/50 px-4 py-3 font-mono text-body text-on-surface placeholder:text-outline-variant shadow-sm outline-none transition-all focus:border-primary-container focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary-container"
              />
              {priorPreauthAmount !== null ? (
                <span className="text-[11px] text-on-surface-variant">
                  Prior: {fmtINR(priorPreauthAmount)}
                  {Number.isFinite(Number(revisedRupees)) && Number(revisedRupees) > 0
                    ? ` · delta: ${fmtINR(Math.round(Number(revisedRupees) * 100) - priorPreauthAmount)}`
                    : ''}
                </span>
              ) : null}
            </div>
            <div className="flex flex-col gap-1 md:col-span-1">
              <label
                htmlFor="enh-reason"
                className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant"
              >
                Reason
              </label>
              <input
                id="enh-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={2000}
                placeholder="ICU upgrade, extended stay, additional procedure…"
                className="w-full rounded-lg border border-white bg-surface-container-lowest/50 px-4 py-3 text-body text-on-surface placeholder:text-outline-variant shadow-sm outline-none transition-all focus:border-primary-container focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary-container"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={working || !revisedRupees || !reason.trim()}
              className="btn-cta"
              style={{ padding: '12px 24px', fontSize: '13px' }}
            >
              <span
                className="material-symbols-outlined"
                style={{ fontSize: 18, fontVariationSettings: "'FILL' 1" }}
              >
                send
              </span>
              {working ? 'Submitting…' : 'Submit enhancement to payer'}
            </button>
          </div>
        </form>
      ) : null}

      {phase === 'awaiting_decision' ? (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50/60 p-4">
          <span className="material-symbols-outlined mt-0.5 text-amber-700">hourglass_top</span>
          <div className="text-body-sm text-on-surface">
            Enhancement submitted to payer. Waiting for the payer&apos;s decision
            on the revised amount. The case timeline below will record the
            payer&apos;s response when the inbound callback arrives.
          </div>
        </div>
      ) : null}

      {phase === 'terminal' ? (
        <div
          className={
            status === 'ENHANCEMENT_APPROVED'
              ? 'flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50/60 p-4'
              : 'flex items-start gap-3 rounded-lg border border-red-200 bg-red-50/60 p-4'
          }
        >
          <span
            className={
              status === 'ENHANCEMENT_APPROVED'
                ? 'material-symbols-outlined mt-0.5 text-emerald-700'
                : 'material-symbols-outlined mt-0.5 text-red-700'
            }
          >
            {status === 'ENHANCEMENT_APPROVED' ? 'check_circle' : 'block'}
          </span>
          <div className="text-body-sm text-on-surface">
            Enhancement {status === 'ENHANCEMENT_APPROVED' ? 'approved' : 'rejected'} by the
            payer. The claim continues to discharge from here.
          </div>
        </div>
      ) : null}
    </section>
  );
}
