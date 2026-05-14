'use client';

import {
  type KycDocument,
  type KycDocumentType,
  type KycListResponse,
  KYC_ALLOWED_CONTENT_TYPES,
  KYC_MAX_UPLOAD_BYTES,
  LEGAL_AGREEMENT_DOCUMENT_TYPES,
} from '@claims/contracts';
import { useCallback, useEffect, useState } from 'react';

import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';
import { TenantApi } from '../../lib/api/tenant.api';

// Slice ON-3 — Legal agreements upload (DPA + MSA). Same upload
// pipeline as KycDocumentsForm; only the type set + copy differ.
// The completion handling is also different: this form does NOT
// auto-mark the parent step complete, because the server-side
// recompute (KycService.recomputeDerivedSteps) is authoritative.
// The wizard's step row flips green on the next list-steps fetch
// after the user uploads + finalizes both legal types.

const TYPE_LABELS: Record<KycDocumentType, string> = {
  hospital_registration: '',
  rohini_registration: '',
  gst_certificate: '',
  pan: '',
  signatory_id: '',
  cancelled_cheque: '',
  dpa_signed: 'Signed Data Processing Agreement (DPA)',
  msa_signed: 'Signed Master Services Agreement (MSA)',
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

export function LegalAgreementsForm(): JSX.Element {
  const { showApiError, showError } = useErrorModal();
  const [summary, setSummary] = useState<KycListResponse | null>(null);
  const [busyType, setBusyType] = useState<KycDocumentType | null>(null);

  const reload = useCallback(async () => {
    try {
      const next = await TenantApi.listKyc();
      setSummary(next);
    } catch (err) {
      showApiError(err);
    }
  }, [showApiError]);

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
    return <p className="text-body-sm text-on-surface-variant">Loading agreements…</p>;
  }

  const latestByType = new Map<KycDocumentType, KycDocument>();
  for (const doc of summary.documents) {
    if (doc.status === 'rejected' || doc.status === 'resubmission_requested') continue;
    if (!latestByType.has(doc.documentType)) latestByType.set(doc.documentType, doc);
  }

  return (
    <div className="space-y-3">
      <p className="text-body-sm text-on-surface-variant">
        Download the platform&apos;s unsigned DPA + MSA from your account manager, sign with
        your authorized signatory (physical or e-signature), and upload the signed PDFs
        here. v1 supports any standard signature method — a built-in e-signature flow is
        on the roadmap.
      </p>
      {LEGAL_AGREEMENT_DOCUMENT_TYPES.map((t) => {
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
                  {doc ? 'check_circle' : 'gavel'}
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
                  <p className="text-body-sm text-on-surface-variant">Not uploaded yet.</p>
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
    </div>
  );
}
