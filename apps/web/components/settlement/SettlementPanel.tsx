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

import { usePrompt } from '../modals/ConfirmDialog/ConfirmDialogProvider';
import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';
import { useToast } from '../toast/ToastProvider';
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

const LABEL_CLS = 'text-eyebrow uppercase tracking-eyebrow text-on-surface-variant';

export function SettlementPanel({
  caseId,
  claimId,
  status,
  onChanged,
}: Props): JSX.Element | null {
  const { showApiError } = useErrorModal();
  const prompt = usePrompt();
  const showToast = useToast();
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('cashless_tpa');
  const [receivedAmount, setReceivedAmount] = useState('');
  const [bankTxnId, setBankTxnId] = useState('');
  const [shortPaymentReasons, setShortPaymentReasons] = useState('');
  const [deductions, setDeductions] = useState<DeductionLine[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  // Slice AY — EOB OCR extraction inputs.
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
      if (r.status === 'extracted' || r.status === 'low_confidence') {
        const f = r.fields;
        if (f?.receivedAmount !== undefined) setReceivedAmount(String(f.receivedAmount));
        if (f?.bankTxnId !== undefined) setBankTxnId(f.bankTxnId);
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

  // Write-off is a TERMINAL FINANCIAL ACTION ("we'll never
  // collect this"). The previous UX was an inline text field +
  // one-click button — too easy to fat-finger past the point of
  // no return. The PromptDialog flow forces the operator to
  // (a) open the dialog, (b) enter a reason of at least 10
  // chars, (c) click the explicit "Write off settlement" button.
  // Each step is reversible until the last click.
  async function onWriteOff(): Promise<void> {
    const reason = await prompt({
      title: 'Write off this settlement?',
      body: (
        <>
          The settlement will be marked <span className="font-semibold">written off</span> —
          the platform stops expecting payment and the claim moves to a terminal
          state. The reason you enter is recorded in the audit log so finance
          can later see why this was closed without full recovery.
        </>
      ),
      label: 'Reason for write-off',
      placeholder: 'e.g. Payer denied appeal; recovery effort exhausted; further escalation not economical.',
      minLength: 10,
      maxLength: 2000,
      multiline: true,
      confirmLabel: 'Write off settlement',
    });
    if (reason === null) return;
    setBusy('writeoff');
    try {
      await CaseApi.writeOffSettlement(caseId, claimId, { reason });
      showToast({ tone: 'success', message: 'Settlement written off.' });
      onChanged();
    } catch (err) {
      showApiError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="glass space-y-5 rounded-xl p-6">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-primary">account_balance_wallet</span>
        <h3 className="text-h3 font-h3 text-on-surface">Settlement</h3>
      </div>

      {settlement === null ? (
        <div className="space-y-3">
          <p className="text-body-sm text-on-surface-variant">
            No settlement open yet. Call expect-payment with the payment mode to begin.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="relative">
              <select
                value={paymentMode}
                onChange={(e) => setPaymentMode(e.target.value as PaymentMode)}
                className="glass-input glass-input--sm appearance-none pr-10"
              >
                <option value="cashless_tpa">cashless_tpa</option>
                <option value="reimbursement">reimbursement</option>
                <option value="patient_oop">patient_oop</option>
                <option value="pmjay_disbursement">pmjay_disbursement</option>
              </select>
              <span className="material-symbols-outlined pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[18px] text-on-surface-variant">
                expand_more
              </span>
            </div>
            <button
              onClick={() =>
                action('expect', () =>
                  CaseApi.expectPayment(caseId, claimId, { paymentMode }),
                )
              }
              disabled={busy === 'expect'}
              className="btn-primary"
              style={{ padding: '8px 18px', fontSize: '13px' }}
            >
              <span className="material-symbols-outlined text-[18px]">hourglass_top</span>
              {busy === 'expect' ? '…' : 'Expect payment'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-body-sm md:grid-cols-2">
            <KvField label="Mode" value={settlement.paymentMode} mono />
            <KvField
              label="Expected (₹)"
              value={fmtAmount(settlement.expectedAmount)}
              mono
            />
            <KvField
              label="Received (₹)"
              value={fmtAmount(settlement.receivedAmount)}
              mono
            />
            <KvField
              label="Deduction (₹)"
              value={fmtAmount(settlement.deductionAmount)}
              mono
            />
            <KvField label="Status" value={settlement.reconciliationStatus} />
            {settlement.shortPaymentReasons.length > 0 ? (
              <KvField
                label="Short reasons"
                value={settlement.shortPaymentReasons.join('; ')}
              />
            ) : null}
          </dl>

          {/* PAYMENT_PENDING — record receipt with optional EOB extraction */}
          {status === 'PAYMENT_PENDING' ? (
            <div className="space-y-4 border-t border-surface-variant/50 pt-4">
              {eobDocs.length > 0 ? (
                <div className="space-y-3 rounded-lg border border-white/40 bg-surface-container-lowest/50 p-4">
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="flex flex-col gap-1">
                      <span className={LABEL_CLS}>Extract from EOB</span>
                      <div className="relative">
                        <select
                          value={selectedEobDocId}
                          onChange={(e) => setSelectedEobDocId(e.target.value)}
                          className="glass-input glass-input--sm appearance-none pr-10"
                        >
                          {eobDocs.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.originalFilename}
                            </option>
                          ))}
                        </select>
                        <span className="material-symbols-outlined pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[18px] text-on-surface-variant">
                          expand_more
                        </span>
                      </div>
                    </label>
                    <button
                      onClick={() => {
                        const doc = eobDocs.find((d) => d.id === selectedEobDocId);
                        if (doc) void viewDoc(doc.id, doc.originalFilename);
                      }}
                      disabled={busy?.startsWith('view:') === true || !selectedEobDocId}
                      className="btn-outline"
                      style={{ padding: '8px 14px', fontSize: '13px' }}
                    >
                      <span className="material-symbols-outlined text-[18px]">
                        open_in_new
                      </span>
                      View
                    </button>
                    <button
                      onClick={() => void runExtract()}
                      disabled={busy === 'extract' || !selectedEobDocId}
                      className="btn-outline"
                      style={{ padding: '8px 14px', fontSize: '13px' }}
                    >
                      <span className="material-symbols-outlined text-[18px]">
                        document_scanner
                      </span>
                      {busy === 'extract' ? '…' : 'Extract'}
                    </button>
                  </div>
                  {extractResult ? <ExtractSummary result={extractResult} /> : null}
                </div>
              ) : null}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5">
                  <span className={LABEL_CLS}>Received amount (₹)</span>
                  <input
                    type="number"
                    value={receivedAmount}
                    onChange={(e) => setReceivedAmount(e.target.value)}
                    className="glass-input glass-input--sm font-mono tabular-nums"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={LABEL_CLS}>Bank txn id</span>
                  <input
                    type="text"
                    value={bankTxnId}
                    onChange={(e) => setBankTxnId(e.target.value)}
                    placeholder="(optional)"
                    className="glass-input glass-input--sm font-mono"
                  />
                </label>
                <label className="flex flex-col gap-1.5 sm:col-span-2">
                  <span className={LABEL_CLS}>Short-payment reasons</span>
                  <input
                    type="text"
                    value={shortPaymentReasons}
                    onChange={(e) => setShortPaymentReasons(e.target.value)}
                    placeholder="comma-separated, e.g. Cap exceeded, Co-pay"
                    className="glass-input glass-input--sm"
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
                  className="btn-primary"
                  style={{ padding: '10px 22px', fontSize: '13px' }}
                >
                  <span
                    className="material-symbols-outlined text-[18px]"
                    style={{ fontVariationSettings: "'FILL' 1" }}
                  >
                    check_circle
                  </span>
                  {busy === 'receipt' ? '…' : 'Record receipt'}
                </button>
              </div>
            </div>
          ) : null}

          {/* PAYMENT_RECEIVED — reconcile with optional deduction lines */}
          {status === 'PAYMENT_RECEIVED' ? (
            <div className="space-y-3 border-t border-surface-variant/50 pt-4">
              <div className="flex items-center justify-between">
                <h4 className={LABEL_CLS}>Deductions</h4>
                <button
                  onClick={() =>
                    setDeductions((d) => [...d, { category: '', amount: 0 }])
                  }
                  className="flex items-center gap-1 text-eyebrow uppercase tracking-eyebrow text-primary transition-colors hover:text-primary-container"
                >
                  <span className="material-symbols-outlined text-[16px]">add</span>
                  Add line
                </button>
              </div>
              {deductions.length === 0 ? (
                <p className="text-body-sm text-on-surface-variant">
                  No deductions — reconcile records the payment as fully received. Add lines
                  if the EOB shows category-level reductions.
                </p>
              ) : (
                <div className="space-y-1.5">
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
                      const cleaned = deductions.filter(
                        (d) => d.category.trim().length > 0 || d.amount > 0,
                      );
                      return CaseApi.reconcile(caseId, claimId, {
                        ...(cleaned.length > 0 ? { deductions: cleaned } : {}),
                      });
                    })
                  }
                  disabled={busy === 'reconcile'}
                  className="btn-primary"
                  style={{ padding: '10px 22px', fontSize: '13px' }}
                >
                  <span className="material-symbols-outlined text-[18px]">balance</span>
                  {busy === 'reconcile' ? '…' : 'Reconcile'}
                </button>
              </div>
            </div>
          ) : null}

          {/* SHORT_PAID — write off. Two-step: button opens a
              PromptDialog where the operator captures the reason
              (min 10 chars). Single-click write-off was too easy
              to fat-finger past the point of no return. */}
          {status === 'SHORT_PAID' ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-surface-variant/50 pt-4">
              <p className="text-body-sm text-on-surface-variant">
                Recovery exhausted? Mark this settlement as written off — the
                claim moves to a terminal state and the audit log captures the
                reason you enter.
              </p>
              <button
                onClick={() => void onWriteOff()}
                disabled={busy === 'writeoff'}
                className="inline-flex items-center gap-2 rounded-full bg-error px-5 py-2.5 text-body-sm font-semibold text-on-error shadow-[0_4px_14px_rgba(186,26,26,0.25)] transition hover:bg-[#93000a] disabled:opacity-60"
              >
                <span className="material-symbols-outlined text-[18px]">remove_circle</span>
                {busy === 'writeoff' ? '…' : 'Write off settlement…'}
              </button>
            </div>
          ) : null}

          {status === 'PAYMENT_RECONCILED' || status === 'WRITTEN_OFF' ? (
            <div className="flex justify-end border-t border-surface-variant/50 pt-4">
              <button
                onClick={() => action('close', () => CaseApi.closeSettlement(caseId, claimId))}
                disabled={busy === 'close'}
                className="btn-outline"
                style={{ padding: '8px 18px', fontSize: '13px' }}
              >
                <span className="material-symbols-outlined text-[18px]">lock</span>
                {busy === 'close' ? '…' : 'Close claim'}
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function fmtAmount(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n)) return String(v);
  return `₹${n.toLocaleString('en-IN')}`;
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
      <dt className={LABEL_CLS}>{label}</dt>
      <dd className={`text-on-surface ${mono ? 'font-mono tabular-nums text-body-sm' : ''}`}>
        {value}
      </dd>
    </div>
  );
}

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
    <div className="grid grid-cols-12 items-center gap-2">
      <input
        type="text"
        value={value.category}
        onChange={(e) => onChange({ ...value, category: e.target.value })}
        placeholder="category"
        className="glass-input glass-input--sm col-span-3"
      />
      <input
        type="number"
        value={value.amount}
        onChange={(e) =>
          onChange({ ...value, amount: Number.parseInt(e.target.value, 10) || 0 })
        }
        placeholder="₹"
        className="glass-input glass-input--sm col-span-2 text-right font-mono tabular-nums"
      />
      <input
        type="text"
        value={value.reason ?? ''}
        onChange={(e) => onChange({ ...value, reason: e.target.value })}
        placeholder="reason (optional)"
        className="glass-input glass-input--sm col-span-6"
      />
      <button
        onClick={onRemove}
        aria-label="Remove deduction"
        className="col-span-1 inline-flex items-center justify-center text-error transition-colors hover:text-[#93000a]"
      >
        <span className="material-symbols-outlined">delete</span>
      </button>
    </div>
  );
}

function ExtractSummary({ result }: { result: EobExtractResponse }): JSX.Element {
  const tone =
    result.status === 'extracted'
      ? 'border-green-200 bg-green-50 text-green-700'
      : result.status === 'low_confidence'
        ? 'border-amber-200 bg-amber-50 text-amber-700'
        : 'border-outline-variant/40 bg-surface-container-lowest text-on-surface-variant';
  const f = result.fields;
  const conf = f?.confidence;
  return (
    <div className={`space-y-2 rounded-lg border px-3 py-2 text-body-sm ${tone}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">
          {result.status.replace(/_/g, ' ')} ({result.engine})
        </span>
        <div className="flex items-center gap-2">
          {f?.payerCode ? (
            <span className="rounded-md border border-outline-variant/40 bg-white/80 px-2 py-0.5 font-mono text-[10px] text-on-surface-variant">
              payer: {f.payerCode}
            </span>
          ) : null}
          {result.error ? <span className="text-error">{result.error}</span> : null}
        </div>
      </div>
      {f ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-body-sm">
          {f.claimRefNum ? (
            <>
              <dt className="text-on-surface-variant">
                <ConfidenceDot value={conf?.claimRefNum} /> claimRefNum
              </dt>
              <dd className="font-mono">{f.claimRefNum}</dd>
            </>
          ) : null}
          {f.receivedAmount !== undefined ? (
            <>
              <dt className="text-on-surface-variant">
                <ConfidenceDot value={conf?.receivedAmount} /> receivedAmount
              </dt>
              <dd className="font-mono tabular-nums">{f.receivedAmount}</dd>
            </>
          ) : null}
          {f.deductionAmount !== undefined ? (
            <>
              <dt className="text-on-surface-variant">
                <ConfidenceDot value={conf?.deductionAmount} /> deductionAmount
              </dt>
              <dd className="font-mono tabular-nums">{f.deductionAmount}</dd>
            </>
          ) : null}
          {f.bankTxnId ? (
            <>
              <dt className="text-on-surface-variant">
                <ConfidenceDot value={conf?.bankTxnId} /> bankTxnId
              </dt>
              <dd className="font-mono">{f.bankTxnId}</dd>
            </>
          ) : null}
          {f.receivedAt ? (
            <>
              <dt className="text-on-surface-variant">
                <ConfidenceDot value={conf?.receivedAt} /> receivedAt
              </dt>
              <dd className="font-mono">{f.receivedAt}</dd>
            </>
          ) : null}
          {f.deductions.length > 0 ? (
            <>
              <dt className="text-on-surface-variant">deductions</dt>
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

function ConfidenceDot({ value }: { value: number | undefined }): JSX.Element {
  let cls = 'bg-outline-variant';
  let title = 'Confidence not reported';
  if (value !== undefined) {
    if (value >= 0.8) {
      cls = 'bg-green-500';
      title = `High confidence (${value.toFixed(2)})`;
    } else if (value >= 0.5) {
      cls = 'bg-amber-500';
      title = `Medium confidence (${value.toFixed(2)}) — please verify`;
    } else {
      cls = 'bg-error';
      title = `Low confidence (${value.toFixed(2)}) — verify before saving`;
    }
  }
  return (
    <span
      className={`mr-1 inline-block h-2 w-2 rounded-full ${cls}`}
      title={title}
      aria-label={title}
    />
  );
}
