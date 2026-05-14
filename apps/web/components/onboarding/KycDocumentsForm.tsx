'use client';

import {
  type KycDocument,
  type KycDocumentType,
  type KycListResponse,
  KYC_ALLOWED_CONTENT_TYPES,
  KYC_MAX_UPLOAD_BYTES,
  REQUIRED_KYC_DOCUMENT_TYPES,
} from '@claims/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';
import { TenantApi } from '../../lib/api/tenant.api';

// Slice ON-2 — KYC document uploader. Renders inline inside the
// `kyc_documents_uploaded` onboarding step. Per required doc type:
//   - if no upload yet: a file picker that runs init → PUT → finalize
//   - if an upload exists: filename + status badge + delete (until ops acts)
// When every required type has a non-rejected row, fires
// `onCoverageComplete` so the wizard can auto-mark the step complete.

const TYPE_LABELS: Record<KycDocumentType, string> = {
  hospital_registration: 'Hospital registration certificate',
  rohini_registration: 'ROHINI registration proof',
  gst_certificate: 'GST certificate',
  pan: 'PAN',
  signatory_id: 'Authorized signatory ID',
  cancelled_cheque: 'Cancelled cheque',
  dpa_signed: 'Signed DPA',
  msa_signed: 'Signed MSA',
};

const STATUS_BADGES: Record<
  KycDocument['status'],
  { label: string; cls: string }
> = {
  uploading: {
    label: 'Uploading…',
    cls: 'border-blue-100 bg-blue-50 text-blue-700',
  },
  pending_review: {
    label: 'Awaiting ops review',
    cls: 'border-amber-100 bg-amber-50 text-amber-700',
  },
  approved: {
    label: 'Approved',
    cls: 'border-green-100 bg-green-50 text-green-700',
  },
  rejected: {
    label: 'Rejected — please re-upload',
    cls: 'border-red-100 bg-red-50 text-red-700',
  },
  resubmission_requested: {
    label: 'Resubmission requested',
    cls: 'border-amber-100 bg-amber-50 text-amber-700',
  },
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function KycDocumentsForm({
  onCoverageComplete,
}: {
  onCoverageComplete: () => void;
}): JSX.Element {
  const { showApiError, showError } = useErrorModal();
  const [summary, setSummary] = useState<KycListResponse | null>(null);
  const [busyType, setBusyType] = useState<KycDocumentType | null>(null);
  // We deliberately only call onCoverageComplete on the transition
  // from false→true, not every render — avoids a re-mark-complete loop.
  const previouslyComplete = useRef(false);

  const reload = useCallback(async () => {
    try {
      const next = await TenantApi.listKyc();
      setSummary(next);
      if (next.requiredCoverageComplete && !previouslyComplete.current) {
        previouslyComplete.current = true;
        onCoverageComplete();
      } else if (!next.requiredCoverageComplete) {
        previouslyComplete.current = false;
      }
    } catch (err) {
      showApiError(err);
    }
  }, [onCoverageComplete, showApiError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function upload(documentType: KycDocumentType, file: File): Promise<void> {
    if (file.size === 0) {
      showError('VALIDATION_FAILED', 'Empty file. Please pick a real document.');
      return;
    }
    if (file.size > KYC_MAX_UPLOAD_BYTES) {
      showError(
        'VALIDATION_FAILED',
        `File is ${formatBytes(file.size)}; the limit is ${formatBytes(KYC_MAX_UPLOAD_BYTES)}.`,
      );
      return;
    }
    if (!KYC_ALLOWED_CONTENT_TYPES.includes(file.type)) {
      showError(
        'VALIDATION_FAILED',
        `Unsupported file type "${file.type}". Use PDF, JPEG, or PNG.`,
      );
      return;
    }
    setBusyType(documentType);
    try {
      const init = await TenantApi.kycUploadInit({
        documentType,
        originalFilename: file.name,
        contentType: file.type,
        sizeBytes: file.size,
      });
      // PUT bytes direct to storage. The stub adapter's `stub://` URL
      // is unreachable, so we skip the PUT in that case — finalize
      // still works because the stub HEAD returns synthetic data.
      if (!init.uploadUrl.startsWith('stub://')) {
        const putRes = await fetch(init.uploadUrl, {
          method: 'PUT',
          headers: init.requiredHeaders,
          body: file,
        });
        if (!putRes.ok) {
          throw new Error(`Upload PUT failed: ${putRes.status} ${putRes.statusText}`);
        }
      }
      await TenantApi.kycFinalize(init.document.id, {});
      await reload();
    } catch (err) {
      showApiError(err);
    } finally {
      setBusyType(null);
    }
  }

  async function remove(documentId: string, documentType: KycDocumentType): Promise<void> {
    setBusyType(documentType);
    try {
      await TenantApi.kycDelete(documentId);
      await reload();
    } catch (err) {
      showApiError(err);
    } finally {
      setBusyType(null);
    }
  }

  if (!summary) {
    return <p className="text-body-sm text-on-surface-variant">Loading documents…</p>;
  }

  // Map: per required type, the most recent non-rejected row (if any).
  const latestByType = new Map<KycDocumentType, KycDocument>();
  for (const doc of summary.documents) {
    if (doc.status === 'rejected' || doc.status === 'resubmission_requested') continue;
    if (!latestByType.has(doc.documentType)) latestByType.set(doc.documentType, doc);
  }

  return (
    <div className="space-y-3">
      {REQUIRED_KYC_DOCUMENT_TYPES.map((t) => {
        const doc = latestByType.get(t);
        const busy = busyType === t;
        return (
          <div
            key={t}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-outline-variant/40 bg-white/50 px-3 py-2"
          >
            <div className="flex items-center gap-3">
              <span
                aria-hidden
                className={`flex h-7 w-7 items-center justify-center rounded-full ${
                  doc
                    ? 'bg-green-500/15 text-green-700'
                    : 'bg-surface-container text-on-surface-variant'
                }`}
              >
                <span
                  className="material-symbols-outlined text-[18px]"
                  style={doc ? { fontVariationSettings: "'FILL' 1" } : undefined}
                >
                  {doc ? 'check_circle' : 'description'}
                </span>
              </span>
              <div>
                <p className="text-body font-medium text-on-surface">{TYPE_LABELS[t]}</p>
                {doc ? (
                  <p className="text-body-sm text-on-surface-variant">
                    {doc.originalFilename}
                    {doc.actualSizeBytes !== null
                      ? ` · ${formatBytes(doc.actualSizeBytes)}`
                      : ` · ${formatBytes(doc.declaredSizeBytes)}`}
                  </p>
                ) : (
                  <p className="text-body-sm text-on-surface-variant">
                    Not uploaded yet.
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {doc && (
                <span
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-body-sm font-medium ${STATUS_BADGES[doc.status].cls}`}
                >
                  {STATUS_BADGES[doc.status].label}
                </span>
              )}
              {doc &&
                (doc.status === 'uploading' || doc.status === 'pending_review') && (
                  <button
                    type="button"
                    onClick={() => remove(doc.id, t)}
                    disabled={busy}
                    className="text-body-sm font-medium text-red-700 hover:underline disabled:opacity-50"
                  >
                    {busy ? '…' : 'Remove'}
                  </button>
                )}
              <label
                className={`btn-primary inline-flex cursor-pointer items-center ${
                  busy ? 'opacity-60' : ''
                }`}
                style={{ padding: '6px 12px', fontSize: '12px' }}
              >
                <input
                  type="file"
                  accept={KYC_ALLOWED_CONTENT_TYPES.join(',')}
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void upload(t, file);
                    e.target.value = '';
                  }}
                  className="hidden"
                />
                <span
                  className="material-symbols-outlined text-[16px]"
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  upload
                </span>
                {busy ? 'Uploading…' : doc ? 'Replace' : 'Upload'}
              </label>
            </div>
          </div>
        );
      })}
      <p className="text-body-sm text-on-surface-variant">
        Accepted formats: PDF, JPEG, PNG. Max {formatBytes(KYC_MAX_UPLOAD_BYTES)} per file.
        Uploads remain editable until DigiSparsh ops starts reviewing them.
      </p>
    </div>
  );
}
