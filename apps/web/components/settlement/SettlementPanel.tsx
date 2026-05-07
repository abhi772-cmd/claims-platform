'use client';

import {
  type ClaimStatus,
  type DeductionLine,
  type Document,
  type EobExtractResponse,
  type PaymentMode,
  type Settlement,
} from '@claims/contracts';
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
  // Slice BA — pre-fillable from EOB extraction; passed through on
  // recordReceipt so finance can reconcile back to the bank line.
  const [bankTxnId, setBankTxnId] = useState('');
  // Comma-separated for the input; split on submit.
  const [shortPaymentReasons, setShortPaymentReasons] = useState('');
  // Slice BB — structured deductions captured at reconcile time.
  // Pre-filled from the AY extraction when the operator runs Extract
  // on a SHORT_PAID claim's EOB; otherwise the operator adds rows by
  // hand. Empty rows are dropped at submit so the API call stays
  // tidy.
  const [deductions, setDeductions] = useState<DeductionLine[]>([]);
  const [writeOffReason, setWriteOffReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  // Slice AY — EOB OCR extraction. We list the claim's EOB-typed
  // documents and let the operator pick one to extract from. The
  // API returns receivedAmount + deduction info that pre-fills the
  // receipt form below, so the operator can verify + submit instead
  // of typing fields off the EOB by hand.
  const [eobDocs, setEobDocs] = useState<Document[]>([]);
  const [selectedEobDocId, setSelectedEobDocId] = useState<string>('');
  const [extractResult, setExtractResult] = useState<EobExtractResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    CaseApi.getSettlement(caseId, claimId)
      .then((r) => {
        if (!cancelled) setSettlement(r.settlement);
      })
      .catch((err: unknown) => {
        if (!cancelled) showApiError(err);
      });
    CaseApi.listDocuments(caseId, claimId)
      .then((r) => {
        if (cancelled) return;
        const eobs = r.documents.filter(
          (d) => d.documentType === 'EOB' && d.uploadStatus === 'completed',
        );
        setEobDocs(eobs);
        if (eobs.length > 0 && !selectedEobDocId) {
          setSelectedEobDocId(eobs[0]!.id);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) showApiError(err);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId, claimId, status]);

  async function runExtract(): Promise<void> {
    if (!selectedEobDocId) return;
    setBusy('extract');
    try {
      const r = await CaseApi.eobExtract(caseId, claimId, selectedEobDocId, {});
      setExtractResult(r);
      // Pre-fill receipt-form fields when the OCR found values. We
      // don't pre-fill on `failed` / `skipped` — operator sees the
      // status banner and can extract again or type by hand.
      if (r.status === 'extracted' || r.status === 'low_confidence') {
        const f = r.fields;
        if (f?.receivedAmount !== undefined) {
          setReceivedAmount(String(f.receivedAmount));
        }
        if (f?.bankTxnId !== undefined) {
          setBankTxnId(f.bankTxnId);
        }
        if (f?.shortPaymentReasons !== undefined && f.shortPaymentReasons.length > 0) {
          setShortPaymentReasons(f.shortPaymentReasons.join(', '));
        }
        if (f?.deductions !== undefined && f.deductions.length > 0) {
          setDeductions(f.deductions);
        }
      }
    } catch (err) {
      showApiError(err);
    } finally {
      setBusy(null);
    }
  }

  // Slice BA — open the EOB in a new tab via a presigned download URL.
  // The URL expires after the configured TTL, so we fetch on-click
  // rather than caching anything in component state.
  async function viewDoc(documentId: string, filename: string): Promise<void> {
    setBusy(`view:${documentId}`);
    try {
      const r = await CaseApi.getDocumentDownloadUrl(caseId, claimId, documentId, filename);
      window.open(r.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      showApiError(err);
    } finally {
      setBusy(null);
    }
  }

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
            <div className="space-y-3 border-t border-neutral-100 pt-3">
              {eobDocs.length > 0 ? (
                <div className="space-y-2 rounded-sm bg-neutral-50 p-2">
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-neutral-500">
                      Extract from EOB
                      <select
                        value={selectedEobDocId}
                        onChange={(e) => setSelectedEobDocId(e.target.value)}
                        className="rounded-sm border border-neutral-200 bg-neutral-0 px-2 py-1 text-xs"
                      >
                        {eobDocs.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.originalFilename}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      onClick={() => {
                        const doc = eobDocs.find((d) => d.id === selectedEobDocId);
                        if (doc) void viewDoc(doc.id, doc.originalFilename);
                      }}
                      disabled={busy?.startsWith('view:') === true || !selectedEobDocId}
                      className="rounded-sm border border-neutral-300 bg-neutral-0 px-2 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-60"
                    >
                      {busy?.startsWith('view:') === true ? '…' : 'View'}
                    </button>
                    <button
                      onClick={() => void runExtract()}
                      disabled={busy === 'extract' || !selectedEobDocId}
                      className="rounded-sm border border-neutral-300 bg-neutral-0 px-2 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-60"
                    >
                      {busy === 'extract' ? '…' : 'Extract'}
                    </button>
                  </div>
                  {extractResult ? (
                    <ExtractSummary result={extractResult} />
                  ) : null}
                </div>
              ) : null}

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-neutral-500">
                  Received amount (₹)
                  <input
                    type="number"
                    value={receivedAmount}
                    onChange={(e) => setReceivedAmount(e.target.value)}
                    className="rounded-sm border border-neutral-200 bg-neutral-0 px-2 py-1 text-xs"
                  />
                </label>
                <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-neutral-500">
                  Bank txn id
                  <input
                    type="text"
                    value={bankTxnId}
                    onChange={(e) => setBankTxnId(e.target.value)}
                    placeholder="(optional)"
                    className="rounded-sm border border-neutral-200 bg-neutral-0 px-2 py-1 font-mono text-xs"
                  />
                </label>
                <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-neutral-500 sm:col-span-2">
                  Short-payment reasons
                  <input
                    type="text"
                    value={shortPaymentReasons}
                    onChange={(e) => setShortPaymentReasons(e.target.value)}
                    placeholder="comma-separated, e.g. Cap exceeded, Co-pay"
                    className="rounded-sm border border-neutral-200 bg-neutral-0 px-2 py-1 text-xs"
                  />
                </label>
              </div>
              <div className="flex justify-end">
                <button
                  onClick={() =>
                    action('receipt', () => {
                      const reasons = shortPaymentReasons
                        .split(',')
                        .map((r) => r.trim())
                        .filter((r) => r.length > 0);
                      return CaseApi.recordReceipt(caseId, claimId, {
                        receivedAmount: Number.parseInt(receivedAmount, 10),
                        ...(bankTxnId.length > 0 ? { bankTxnId } : {}),
                        ...(reasons.length > 0 ? { shortPaymentReasons: reasons } : {}),
                      });
                    })
                  }
                  disabled={busy === 'receipt' || !receivedAmount}
                  className="rounded-sm bg-primary-600 px-2 py-1 text-xs font-medium text-neutral-0 hover:bg-primary-700 disabled:opacity-60"
                >
                  {busy === 'receipt' ? '…' : 'Record receipt'}
                </button>
              </div>
            </div>
          ) : null}

          {status === 'PAYMENT_RECEIVED' ? (
            <div className="space-y-2 border-t border-neutral-100 pt-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-neutral-700">Deductions</h3>
                <button
                  onClick={() =>
                    setDeductions((d) => [
                      ...d,
                      { category: '', amount: 0 },
                    ])
                  }
                  className="text-[10px] uppercase tracking-wide text-primary-600 hover:underline"
                >
                  + Add line
                </button>
              </div>
              {deductions.length === 0 ? (
                <p className="text-[11px] text-neutral-500">
                  No deductions — reconcile records the payment as fully received.
                  Add lines if the EOB shows category-level reductions.
                </p>
              ) : (
                <div className="space-y-1">
                  {deductions.map((d, i) => (
                    <DeductionRow
                      key={i}
                      value={d}
                      onChange={(next) =>
                        setDeductions((arr) =>
                          arr.map((x, idx) => (idx === i ? next : x)),
                        )
                      }
                      onRemove={() =>
                        setDeductions((arr) => arr.filter((_, idx) => idx !== i))
                      }
                    />
                  ))}
                </div>
              )}
              <div className="flex justify-end">
                <button
                  onClick={() =>
                    action('reconcile', () => {
                      // Drop empty rows so an over-eager Add doesn't
                      // tag a meaningless `{ category: '', amount: 0 }`
                      // onto the request.
                      const cleaned = deductions.filter(
                        (d) => d.category.trim().length > 0 || d.amount > 0,
                      );
                      return CaseApi.reconcile(caseId, claimId, {
                        ...(cleaned.length > 0 ? { deductions: cleaned } : {}),
                      });
                    })
                  }
                  disabled={busy === 'reconcile'}
                  className="rounded-sm bg-primary-600 px-2 py-1 text-xs font-medium text-neutral-0 hover:bg-primary-700 disabled:opacity-60"
                >
                  {busy === 'reconcile' ? '…' : 'Reconcile'}
                </button>
              </div>
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

// Slice BB — single deduction line in the reconcile form. We split
// this out so Add line can stamp empty rows the operator fills in,
// and pre-filled rows from EOB extraction render the same way.
function DeductionRow({
  value,
  onChange,
  onRemove,
}: {
  value: DeductionLine;
  onChange: (next: DeductionLine) => void;
  onRemove: () => void;
}): JSX.Element {
  return (
    <div className="grid grid-cols-12 items-center gap-1">
      <input
        type="text"
        value={value.category}
        onChange={(e) => onChange({ ...value, category: e.target.value })}
        placeholder="category"
        className="col-span-3 rounded-sm border border-neutral-200 bg-neutral-0 px-2 py-1 text-xs"
      />
      <input
        type="number"
        value={value.amount}
        onChange={(e) =>
          onChange({ ...value, amount: Number.parseInt(e.target.value, 10) || 0 })
        }
        placeholder="₹"
        className="col-span-2 rounded-sm border border-neutral-200 bg-neutral-0 px-2 py-1 text-right text-xs"
      />
      <input
        type="text"
        value={value.reason ?? ''}
        onChange={(e) => onChange({ ...value, reason: e.target.value })}
        placeholder="reason (optional)"
        className="col-span-6 rounded-sm border border-neutral-200 bg-neutral-0 px-2 py-1 text-xs"
      />
      <button
        onClick={onRemove}
        className="col-span-1 rounded-sm text-[10px] uppercase tracking-wide text-error-700 hover:underline"
      >
        Remove
      </button>
    </div>
  );
}

// Renders the extract response inline so the operator can verify the
// auto-fill before clicking Record receipt. Each non-trivial field
// gets a row; deduction lines stack below.
function ExtractSummary({ result }: { result: EobExtractResponse }): JSX.Element {
  const tone =
    result.status === 'extracted'
      ? 'border-success-200 bg-success-50 text-success-700'
      : result.status === 'low_confidence'
        ? 'border-warning-200 bg-warning-50 text-warning-700'
        : 'border-neutral-200 bg-neutral-0 text-neutral-700';
  const f = result.fields;
  return (
    <div className={`space-y-1 rounded-sm border px-2 py-1 text-[11px] ${tone}`}>
      <div className="flex items-center justify-between">
        <span className="font-medium">
          {result.status.replace(/_/g, ' ')} ({result.engine})
        </span>
        {result.error ? <span className="text-error-700">{result.error}</span> : null}
      </div>
      {f ? (
        <dl className="grid grid-cols-2 gap-x-4 text-[11px]">
          {f.claimRefNum ? (
            <>
              <dt className="text-neutral-500">claimRefNum</dt>
              <dd className="font-mono">{f.claimRefNum}</dd>
            </>
          ) : null}
          {f.receivedAmount !== undefined ? (
            <>
              <dt className="text-neutral-500">receivedAmount</dt>
              <dd>{f.receivedAmount}</dd>
            </>
          ) : null}
          {f.deductionAmount !== undefined ? (
            <>
              <dt className="text-neutral-500">deductionAmount</dt>
              <dd>{f.deductionAmount}</dd>
            </>
          ) : null}
          {f.bankTxnId ? (
            <>
              <dt className="text-neutral-500">bankTxnId</dt>
              <dd className="font-mono">{f.bankTxnId}</dd>
            </>
          ) : null}
          {f.deductions.length > 0 ? (
            <>
              <dt className="text-neutral-500">deductions</dt>
              <dd>
                {f.deductions.map((d, i) => (
                  <div key={i}>
                    {d.category}: {d.amount}
                    {d.reason ? ` — ${d.reason}` : ''}
                  </div>
                ))}
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}
