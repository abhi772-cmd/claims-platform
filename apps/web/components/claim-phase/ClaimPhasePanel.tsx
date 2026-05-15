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
    <section className="glass space-y-6 rounded-xl p-6">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-primary">medical_information</span>
        <h3 className="text-h3 font-h3 text-on-surface">Discharge &amp; claim</h3>
      </div>

      {/* Documents */}
      <div className="space-y-3">
        <span className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
          Documents
        </span>
        {docs.length === 0 ? (
          <p className="text-body-sm text-on-surface-variant/70">None uploaded.</p>
        ) : (
          <ul className="space-y-1.5">
            {docs.map((d) => (
              <li
                key={d.id}
                className="flex items-center gap-2 rounded-lg border border-white/40 bg-surface-container-lowest/50 p-2.5 text-body-sm"
              >
                <span className="material-symbols-outlined text-[18px] text-primary">
                  description
                </span>
                <span className="font-mono text-on-surface">{d.documentType}</span>
                <span className="text-on-surface-variant">·</span>
                <span className="text-on-surface-variant">{d.originalFilename}</span>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={uploadDoc} className="flex flex-wrap items-end gap-2 pt-1">
          <div className="relative">
            <select
              value={docType}
              onChange={(e) => setDocType(e.target.value as DocumentType)}
              className="glass-input glass-input--sm appearance-none pr-10"
            >
              <option value="discharge_summary">discharge_summary</option>
              <option value="investigation_report">investigation_report</option>
              <option value="implant_sticker">implant_sticker</option>
              <option value="OT_notes">OT_notes</option>
              <option value="final_bill">final_bill</option>
              <option value="other">other</option>
            </select>
            <span className="material-symbols-outlined pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[18px] text-on-surface-variant">
              expand_more
            </span>
          </div>
          <input
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            placeholder="filename.pdf"
            className="glass-input glass-input--sm flex-1 font-mono"
          />
          <button
            type="submit"
            disabled={busy === 'upload' || !filename}
            className="btn-outline"
            style={{ padding: '8px 16px', fontSize: '13px' }}
          >
            <span className="material-symbols-outlined text-[18px]">upload</span>
            {busy === 'upload' ? 'Uploading…' : 'Upload'}
          </button>
        </form>
      </div>

      {/* Discharge */}
      <div className="space-y-3 border-t border-surface-variant/50 pt-4">
        <span className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
          Discharge
        </span>
        <div className="flex flex-wrap gap-2">
          {PREAUTH_DONE.has(status) ? (
            <button
              onClick={() =>
                action('discharge.initiate', () => CaseApi.initiateDischarge(caseId, claimId))
              }
              disabled={busy === 'discharge.initiate'}
              className="btn-primary"
              style={{ padding: '8px 18px', fontSize: '13px' }}
            >
              <span
                className="material-symbols-outlined text-[18px]"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                play_arrow
              </span>
              {busy === 'discharge.initiate' ? '…' : 'Initiate discharge'}
            </button>
          ) : null}
          {status === 'DISCHARGE_PENDING' ? (
            <button
              onClick={() =>
                action('discharge.submit', () => CaseApi.submitDischarge(caseId, claimId))
              }
              disabled={busy === 'discharge.submit'}
              className="btn-primary"
              style={{ padding: '8px 18px', fontSize: '13px' }}
            >
              <span
                className="material-symbols-outlined text-[18px]"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                send
              </span>
              {busy === 'discharge.submit' ? '…' : 'Submit discharge bundle'}
            </button>
          ) : null}
        </div>
      </div>

      {/* Claim submission */}
      <div className="space-y-3 border-t border-surface-variant/50 pt-4">
        <span className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
          Claim submission
        </span>
        <div className="flex flex-wrap items-end gap-2">
          {status === 'DISCHARGE_SUBMITTED' ? (
            <button
              onClick={() =>
                action('claim.start', () => CaseApi.startClaimSubmission(caseId, claimId))
              }
              disabled={busy === 'claim.start'}
              className="btn-primary"
              style={{ padding: '8px 18px', fontSize: '13px' }}
            >
              <span className="material-symbols-outlined text-[18px]">edit_note</span>
              {busy === 'claim.start' ? '…' : 'Start claim drafting'}
            </button>
          ) : null}
          {status === 'CLAIM_DRAFTING' ? (
            <>
              <input
                type="number"
                placeholder="Final amount (₹)"
                value={finalAmount}
                onChange={(e) => setFinalAmount(e.target.value)}
                className="glass-input glass-input--sm w-48 font-mono tabular-nums"
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
                className="btn-primary"
                style={{ padding: '8px 18px', fontSize: '13px' }}
              >
                <span
                  className="material-symbols-outlined text-[18px]"
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  send
                </span>
                {busy === 'claim.submit' ? '…' : 'Submit claim'}
              </button>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}
