'use client';

import { type ClaimStatus, type PaymentMode, type Settlement } from '@claims/contracts';
import { useEffect, useState } from 'react';

import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';
import { CaseApi } from '../../lib/api/case.api';

const SETTLEMENT_VISIBLE_FROM: ReadonlySet<ClaimStatus> = new Set([
  'CLAIM_APPROVED',
  'CLAIM_PARTIALLY_APPROVED',
  'PAYMENT_PENDING',
  'PAYMENT_RECEIVED',
  'PAYMENT_RECONCILED',
  'SHORT_PAID',
  'WRITTEN_OFF',
  'APPEAL_RESOLVED',
  'CLOSED',
]);

interface Props {
  caseId: string;
  claimId: string;
  status: ClaimStatus;
  onChanged: () => void;
}

export function SettlementPanel({
  caseId,
  claimId,
  status,
  onChanged,
}: Props): JSX.Element | null {
  const { showApiError } = useErrorModal();
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('cashless_tpa');
  const [receivedAmount, setReceivedAmount] = useState('');
  const [writeOffReason, setWriteOffReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    CaseApi.getSettlement(caseId, claimId)
      .then((r) => {
        if (!cancelled) setSettlement(r.settlement);
      })
      .catch((err: unknown) => {
        if (!cancelled) showApiError(err);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId, claimId, status]);

  if (!SETTLEMENT_VISIBLE_FROM.has(status)) return null;

  async function action(name: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy(name);
    try {
      await fn();
      onChanged();
    } catch (err) {
      showApiError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-4 rounded-md bg-neutral-0 p-6 shadow-md">
      <h2 className="text-sm font-semibold text-neutral-700">Settlement</h2>

      {settlement === null ? (
        <div className="space-y-2">
          <p className="text-xs text-neutral-500">
            No settlement open yet. Call expect-payment with the payment mode to begin.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <select
              value={paymentMode}
              onChange={(e) => setPaymentMode(e.target.value as PaymentMode)}
              className="rounded-sm border border-neutral-200 bg-neutral-0 px-2 py-1 text-xs"
            >
              <option value="cashless_tpa">cashless_tpa</option>
              <option value="reimbursement">reimbursement</option>
              <option value="patient_oop">patient_oop</option>
              <option value="pmjay_disbursement">pmjay_disbursement</option>
            </select>
            <button
              onClick={() =>
                action('expect', () => CaseApi.expectPayment(caseId, claimId, { paymentMode }))
              }
              disabled={busy === 'expect'}
              className="rounded-sm bg-primary-600 px-2 py-1 text-xs font-medium text-neutral-0 hover:bg-primary-700 disabled:opacity-60"
            >
              {busy === 'expect' ? '…' : 'Expect payment'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
            <dt className="text-neutral-500">Mode</dt>
            <dd className="text-neutral-700">{settlement.paymentMode}</dd>
            <dt className="text-neutral-500">Expected (₹)</dt>
            <dd className="text-neutral-700">{settlement.expectedAmount}</dd>
            <dt className="text-neutral-500">Received (₹)</dt>
            <dd className="text-neutral-700">{settlement.receivedAmount ?? '—'}</dd>
            <dt className="text-neutral-500">Deduction (₹)</dt>
            <dd className="text-neutral-700">{settlement.deductionAmount ?? '—'}</dd>
            <dt className="text-neutral-500">Status</dt>
            <dd className="text-neutral-700">{settlement.reconciliationStatus}</dd>
            {settlement.shortPaymentReasons.length > 0 ? (
              <>
                <dt className="text-neutral-500">Short reasons</dt>
                <dd className="text-neutral-700">
                  {settlement.shortPaymentReasons.join('; ')}
                </dd>
              </>
            ) : null}
          </dl>

          {status === 'PAYMENT_PENDING' ? (
            <div className="flex flex-wrap items-end gap-2 border-t border-neutral-100 pt-3">
              <input
                type="number"
                placeholder="Received amount (₹)"
                value={receivedAmount}
                onChange={(e) => setReceivedAmount(e.target.value)}
                className="w-44 rounded-sm border border-neutral-200 bg-neutral-0 px-2 py-1 text-xs"
              />
              <button
                onClick={() =>
                  action('receipt', () =>
                    CaseApi.recordReceipt(caseId, claimId, {
                      receivedAmount: Number.parseInt(receivedAmount, 10),
                    }),
                  )
                }
                disabled={busy === 'receipt' || !receivedAmount}
                className="rounded-sm bg-primary-600 px-2 py-1 text-xs font-medium text-neutral-0 hover:bg-primary-700 disabled:opacity-60"
              >
                {busy === 'receipt' ? '…' : 'Record receipt'}
              </button>
            </div>
          ) : null}

          {status === 'PAYMENT_RECEIVED' ? (
            <div className="border-t border-neutral-100 pt-3">
              <button
                onClick={() => action('reconcile', () => CaseApi.reconcile(caseId, claimId, {}))}
                disabled={busy === 'reconcile'}
                className="rounded-sm bg-primary-600 px-2 py-1 text-xs font-medium text-neutral-0 hover:bg-primary-700 disabled:opacity-60"
              >
                {busy === 'reconcile' ? '…' : 'Reconcile (auto-match)'}
              </button>
            </div>
          ) : null}

          {status === 'SHORT_PAID' ? (
            <div className="flex flex-wrap items-end gap-2 border-t border-neutral-100 pt-3">
              <input
                type="text"
                placeholder="Write-off reason"
                value={writeOffReason}
                onChange={(e) => setWriteOffReason(e.target.value)}
                className="flex-1 rounded-sm border border-neutral-200 bg-neutral-0 px-2 py-1 text-xs"
              />
              <button
                onClick={() =>
                  action('writeoff', () =>
                    CaseApi.writeOffSettlement(caseId, claimId, { reason: writeOffReason }),
                  )
                }
                disabled={busy === 'writeoff' || !writeOffReason}
                className="rounded-sm bg-error-600 px-2 py-1 text-xs font-medium text-neutral-0 hover:bg-error-700 disabled:opacity-60"
              >
                {busy === 'writeoff' ? '…' : 'Write off'}
              </button>
            </div>
          ) : null}

          {(status === 'PAYMENT_RECONCILED' || status === 'WRITTEN_OFF') ? (
            <div className="border-t border-neutral-100 pt-3">
              <button
                onClick={() => action('close', () => CaseApi.closeSettlement(caseId, claimId))}
                disabled={busy === 'close'}
                className="rounded-sm border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 disabled:opacity-60"
              >
                {busy === 'close' ? '…' : 'Close claim'}
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
