'use client';

import {
  type ClaimStatus,
  type Document,
  type DocumentType,
} from '@claims/contracts';
import { useEffect, useState, type FormEvent } from 'react';

import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';
import { CaseApi } from '../../lib/api/case.api';

const PREAUTH_DONE: ReadonlySet<ClaimStatus> = new Set([
  'PREAUTH_APPROVED',
  'PREAUTH_PARTIALLY_APPROVED',
  'ENHANCEMENT_APPROVED',
  'ENHANCEMENT_REJECTED',
]);

interface Props {
  caseId: string;
  claimId: string;
  status: ClaimStatus;
  onChanged: () => void;
}

export function ClaimPhasePanel({ caseId, claimId, status, onChanged }: Props): JSX.Element | null {
  const { showApiError } = useErrorModal();
  const [docs, setDocs] = useState<Document[]>([]);
  const [docType, setDocType] = useState<DocumentType>('discharge_summary');
  const [filename, setFilename] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [finalAmount, setFinalAmount] = useState('');

  useEffect(() => {
    let cancelled = false;
    CaseApi.listDocuments(caseId, claimId)
      .then((d) => {
        if (!cancelled) setDocs(d.documents);
      })
      .catch((err: unknown) => {
        if (!cancelled) showApiError(err);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId, claimId, status]);

  // Visible from preauth-decision through claim phase (incl. discharge).
  const inDischargeLifecycle =
    PREAUTH_DONE.has(status) ||
    status === 'DISCHARGE_PENDING' ||
    status === 'DISCHARGE_SUBMITTED';
  const inClaimLifecycle =
    status === 'CLAIM_DRAFTING' ||
    status === 'CLAIM_QUEUED' ||
    status === 'CLAIM_SUBMITTED' ||
    status === 'CLAIM_QUERY_RAISED' ||
    status === 'CLAIM_QUERY_RESPONDED';

  if (!inDischargeLifecycle && !inClaimLifecycle) return null;

  async function uploadDoc(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!filename) return;
    setBusy('upload');
    try {
      await CaseApi.uploadDocumentStub(caseId, claimId, {
        documentType: docType,
        originalFilename: filename,
        contentType: 'application/octet-stream',
        sizeBytes: 1024,
      });
      const list = await CaseApi.listDocuments(caseId, claimId);
      setDocs(list.documents);
      setFilename('');
    } catch (err) {
      showApiError(err);
    } finally {
      setBusy(null);
    }
  }

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
      <h2 className="text-sm font-semibold text-neutral-700">Discharge & claim</h2>

      <div className="space-y-2">
        <p className="text-xs text-neutral-500">Documents</p>
        {docs.length === 0 ? (
          <p className="text-xs text-neutral-400">None uploaded.</p>
        ) : (
          <ul className="space-y-1">
            {docs.map((d) => (
              <li key={d.id} className="rounded-sm border border-neutral-100 p-2 text-xs">
                <span className="font-mono text-neutral-700">{d.documentType}</span> ·{' '}
                <span className="text-neutral-500">{d.originalFilename}</span>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={uploadDoc} className="flex flex-wrap items-end gap-2 pt-1">
          <select
            value={docType}
            onChange={(e) => setDocType(e.target.value as DocumentType)}
            className="rounded-sm border border-neutral-200 bg-neutral-0 px-2 py-1 text-xs"
          >
            <option value="discharge_summary">discharge_summary</option>
            <option value="investigation_report">investigation_report</option>
            <option value="implant_sticker">implant_sticker</option>
            <option value="OT_notes">OT_notes</option>
            <option value="final_bill">final_bill</option>
            <option value="other">other</option>
          </select>
          <input
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            placeholder="filename.pdf"
            className="flex-1 rounded-sm border border-neutral-200 bg-neutral-0 px-2 py-1 font-mono text-xs"
          />
          <button
            type="submit"
            disabled={busy === 'upload' || !filename}
            className="rounded-sm border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 disabled:opacity-60"
          >
            {busy === 'upload' ? 'Uploading…' : 'Upload (stub)'}
          </button>
        </form>
      </div>

      <div className="space-y-2 border-t border-neutral-100 pt-3">
        <p className="text-xs text-neutral-500">Discharge</p>
        <div className="flex flex-wrap gap-2">
          {PREAUTH_DONE.has(status) ? (
            <button
              onClick={() => action('discharge.initiate', () => CaseApi.initiateDischarge(caseId, claimId))}
              disabled={busy === 'discharge.initiate'}
              className="rounded-sm bg-primary-600 px-2 py-1 text-xs font-medium text-neutral-0 hover:bg-primary-700 disabled:opacity-60"
            >
              {busy === 'discharge.initiate' ? '…' : 'Initiate discharge'}
            </button>
          ) : null}
          {status === 'DISCHARGE_PENDING' ? (
            <button
              onClick={() => action('discharge.submit', () => CaseApi.submitDischarge(caseId, claimId))}
              disabled={busy === 'discharge.submit'}
              className="rounded-sm bg-primary-600 px-2 py-1 text-xs font-medium text-neutral-0 hover:bg-primary-700 disabled:opacity-60"
            >
              {busy === 'discharge.submit' ? '…' : 'Submit discharge bundle'}
            </button>
          ) : null}
        </div>
      </div>

      <div className="space-y-2 border-t border-neutral-100 pt-3">
        <p className="text-xs text-neutral-500">Claim submission</p>
        <div className="flex flex-wrap gap-2">
          {status === 'DISCHARGE_SUBMITTED' ? (
            <button
              onClick={() =>
                action('claim.start', () => CaseApi.startClaimSubmission(caseId, claimId))
              }
              disabled={busy === 'claim.start'}
              className="rounded-sm bg-primary-600 px-2 py-1 text-xs font-medium text-neutral-0 hover:bg-primary-700 disabled:opacity-60"
            >
              {busy === 'claim.start' ? '…' : 'Start claim drafting'}
            </button>
          ) : null}
          {status === 'CLAIM_DRAFTING' ? (
            <div className="flex items-center gap-2">
              <input
                type="number"
                placeholder="Final amount (₹)"
                value={finalAmount}
                onChange={(e) => setFinalAmount(e.target.value)}
                className="w-40 rounded-sm border border-neutral-200 bg-neutral-0 px-2 py-1 text-xs"
              />
              <button
                onClick={() =>
                  action('claim.submit', () =>
                    CaseApi.submitClaim(caseId, claimId, {
                      finalAmount: Number.parseInt(finalAmount, 10),
                    }),
                  )
                }
                disabled={busy === 'claim.submit' || !finalAmount}
                className="rounded-sm bg-primary-600 px-2 py-1 text-xs font-medium text-neutral-0 hover:bg-primary-700 disabled:opacity-60"
              >
                {busy === 'claim.submit' ? '…' : 'Submit claim'}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
