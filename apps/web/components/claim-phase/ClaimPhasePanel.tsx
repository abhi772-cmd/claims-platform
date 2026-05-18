'use client';

import {
  type ClaimStatus,
  type Document,
  type DocumentType,
} from '@claims/contracts';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { EligibilityPurposeButton } from '../eligibility/EligibilityPurposeButton';
import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';
import { useToast } from '../toast/ToastProvider';
import { CaseApi } from '../../lib/api/case.api';

// Hard upper bound matches UploadInitRequestSchema's 50 MB cap on
// the API. We surface a friendlier error than waiting for the
// server to reject.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

// scanBufferBase64 on finalize caps at 5 MB raw — see
// UploadFinalizeRequestSchema. Files larger than that under
// STORAGE_MODE=stub skip the in-process scan; that's a dev-mode
// limitation, not a production one (real ClamAV streams from S3).
const STUB_SCAN_LIMIT_BYTES = 5 * 1024 * 1024;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Web Crypto SHA-256 of the file bytes. Computed in the browser
// so the server can verify the upload landed intact (real-mode
// requirement at production hardening; optional in stub).
async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked to avoid call-stack overflow on large inputs.
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

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
  // PMJAY needs a `purpose=auth-requirements` eligibility cycle right
  // before claim submit so the operator gets the latest doc checklist.
  // Private rails (NHCX) skip the purpose field; self-pay hides it.
  rail: 'nhcx' | 'pmjay' | 'self_pay';
  onChanged: () => void;
}

export function ClaimPhasePanel({
  caseId,
  claimId,
  status,
  rail,
  onChanged,
}: Props): JSX.Element | null {
  const { showApiError } = useErrorModal();
  const showToast = useToast();
  const [docs, setDocs] = useState<Document[]>([]);
  const [docType, setDocType] = useState<DocumentType>('discharge_summary');
  // Real File — replaces the prior text-input filename. Operators
  // now pick an actual file; the upload flow PUTs the bytes to the
  // presigned URL (or hands them to the stub scanner in dev).
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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

  // Real upload pipeline:
  //   1. uploadInit → server allocates a Document row in 'pending'
  //      state + returns a presigned PUT URL (or 'stub://...' in
  //      STORAGE_MODE=stub).
  //   2. PUT bytes to that URL with requiredHeaders. Stub URLs
  //      skip the network round-trip — the server already has the
  //      metadata row and we hand the bytes back via
  //      scanBufferBase64 on finalize so the in-process scanner
  //      can run.
  //   3. finalize → server HEADs the object (real mode) or scans
  //      the base64 payload (stub mode); row flips to 'completed'.
  async function uploadDoc(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      showApiError(
        new Error(`File is ${fmtBytes(file.size)} — the 50 MB upload limit applies.`),
      );
      return;
    }
    setBusy('upload');
    try {
      const buffer = await file.arrayBuffer();
      const contentSha256 = await sha256Hex(buffer);

      const init = await CaseApi.uploadInit(caseId, claimId, {
        documentType: docType,
        originalFilename: file.name,
        contentType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
      });

      const isStub = init.uploadUrl.startsWith('stub://');
      if (!isStub) {
        const res = await fetch(init.uploadUrl, {
          method: 'PUT',
          headers: init.requiredHeaders,
          body: file,
        });
        if (!res.ok) {
          throw new Error(
            `Upload PUT failed: ${res.status} ${res.statusText}`,
          );
        }
      }

      const finalizeBody: {
        contentSha256: string;
        scanBufferBase64?: string;
      } = { contentSha256 };
      // Under STORAGE_MODE=stub we hand the bytes to the in-process
      // virus scanner via scanBufferBase64. Skip when over the
      // 5 MB scan-buffer cap — finalize accepts the omission; the
      // doc lands without an in-process scan, which is acceptable
      // for dev/stub.
      if (isStub && file.size <= STUB_SCAN_LIMIT_BYTES) {
        finalizeBody.scanBufferBase64 = bytesToBase64(new Uint8Array(buffer));
      }

      await CaseApi.uploadFinalize(
        caseId,
        claimId,
        init.document.id,
        finalizeBody,
      );

      const list = await CaseApi.listDocuments(caseId, claimId);
      setDocs(list.documents);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      showToast({
        tone: 'success',
        message: `Uploaded ${file.name} (${fmtBytes(file.size)}).`,
      });
    } catch (err) {
      showApiError(err);
    } finally {
      setBusy(null);
    }
  }

  // Operator clicks a doc row → fetch a short-lived presigned
  // GET URL, then open it in a new tab. The browser streams
  // bytes direct from object storage; the API server only signs.
  async function openDocument(documentId: string, filename: string): Promise<void> {
    setBusy(`download:${documentId}`);
    try {
      const { url } = await CaseApi.getDocumentDownloadUrl(
        caseId,
        claimId,
        documentId,
        filename,
      );
      if (url.startsWith('stub://')) {
        showToast({
          tone: 'info',
          message: 'Stub storage mode — no real bytes to download in dev.',
        });
        return;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      showApiError(err);
    } finally {
      setBusy(null);
    }
  }

  async function action(
    name: string,
    fn: () => Promise<unknown>,
    successToast?: string,
  ): Promise<void> {
    setBusy(name);
    try {
      await fn();
      if (successToast) showToast({ tone: 'success', message: successToast });
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

      {rail !== 'self_pay' ? (
        <EligibilityPurposeButton
          caseId={caseId}
          claimId={claimId}
          rail={rail}
          purpose="auth-requirements"
          onCompleted={() => onChanged()}
        />
      ) : null}

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
                <button
                  type="button"
                  onClick={() => void openDocument(d.id, d.originalFilename)}
                  disabled={busy === `download:${d.id}`}
                  className="min-w-0 flex-1 truncate text-left text-primary hover:underline disabled:opacity-60"
                  title="Open in a new tab"
                >
                  {d.originalFilename}
                </button>
                <span className="font-mono text-[11px] tabular-nums text-on-surface-variant">
                  {fmtBytes(d.sizeBytes)}
                </span>
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
          {/* Real file picker — replaces the prior filename text
              input. PDF + image content-types are the common cases
              (discharge summary scans, implant stickers); we don't
              restrict the accept attribute so operators can attach
              the occasional .docx or .txt. */}
          <label
            className={`glass-input glass-input--sm flex flex-1 cursor-pointer items-center gap-2 ${file ? 'font-medium text-on-surface' : 'text-on-surface-variant'}`}
          >
            <span className="material-symbols-outlined text-[18px] text-primary">
              attach_file
            </span>
            <span className="min-w-0 flex-1 truncate">
              {file ? `${file.name} · ${fmtBytes(file.size)}` : 'Choose a file…'}
            </span>
            <input
              ref={fileInputRef}
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="hidden"
            />
          </label>
          {file ? (
            <button
              type="button"
              onClick={() => {
                setFile(null);
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
              disabled={busy === 'upload'}
              className="text-[11px] text-on-surface-variant hover:text-primary"
              title="Clear selected file"
            >
              Clear
            </button>
          ) : null}
          <button
            type="submit"
            disabled={busy === 'upload' || !file}
            className="btn-outline"
            style={{ padding: '8px 16px', fontSize: '13px' }}
          >
            <span className="material-symbols-outlined text-[18px]">upload</span>
            {busy === 'upload' ? 'Uploading…' : 'Upload'}
          </button>
        </form>
        {file && file.size > MAX_UPLOAD_BYTES ? (
          <p className="text-[11px] font-medium text-red-700">
            {fmtBytes(file.size)} exceeds the 50 MB upload limit.
          </p>
        ) : null}
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
                action(
                  'discharge.initiate',
                  () => CaseApi.initiateDischarge(caseId, claimId),
                  'Discharge initiated — upload supporting documents below.',
                )
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
                action(
                  'discharge.submit',
                  () => CaseApi.submitDischarge(caseId, claimId),
                  'Discharge bundle submitted to payer.',
                )
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
                action(
                  'claim.start',
                  () => CaseApi.startClaimSubmission(caseId, claimId),
                  'Claim drafting started.',
                )
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
                  action(
                    'claim.submit',
                    () =>
                      CaseApi.submitClaim(caseId, claimId, {
                        finalAmount: Number.parseInt(finalAmount, 10),
                      }),
                    'Claim submitted to payer — IRDAI 3-hour timer started.',
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
