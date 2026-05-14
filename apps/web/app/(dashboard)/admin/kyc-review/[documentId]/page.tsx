'use client';

import {
  type KycReviewAction,
  type KycReviewDetail,
  KYC_REJECTION_REASON_HINTS,
} from '@claims/contracts';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { useErrorModal } from '../../../../../components/modals/ErrorModal/ErrorModalProvider';
import { KycReviewApi } from '../../../../../lib/api/kyc-review.api';

const ACTION_LABELS: Record<KycReviewAction, string> = {
  approve: 'Approve',
  reject: 'Reject',
  request_resubmission: 'Request resubmission',
};

export default function KycReviewDetailPage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const params = useParams<{ documentId: string }>();
  const router = useRouter();
  const [detail, setDetail] = useState<KycReviewDetail | null>(null);
  const [action, setAction] = useState<KycReviewAction>('approve');
  const [notes, setNotes] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!params.documentId) return;
    let cancelled = false;
    KycReviewApi.detail(params.documentId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err) => showApiError(err));
    return () => {
      cancelled = true;
    };
  }, [params.documentId, showApiError]);

  async function submit(): Promise<void> {
    if (!detail) return;
    setSubmitting(true);
    try {
      await KycReviewApi.review(detail.item.document.id, {
        action,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(reasonCode.trim() ? { rejectionReasonCode: reasonCode.trim() } : {}),
      });
      router.push('/admin/kyc-review');
    } catch (err) {
      showApiError(err);
    } finally {
      setSubmitting(false);
    }
  }

  if (!detail) {
    return (
      <div className="glass max-w-md rounded-xl p-6">
        <p className="text-body text-on-surface-variant">Loading document…</p>
      </div>
    );
  }

  const { item, download } = detail;
  const requiresReason = action === 'reject' || action === 'request_resubmission';
  const requiresNotes = action === 'request_resubmission';

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-6">
      <header className="glass rounded-xl p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <Link
              href="/admin/kyc-review"
              className="text-body-sm font-medium text-primary hover:underline"
            >
              ← Back to queue
            </Link>
            <h2 className="mt-2 text-h2 font-h2 text-on-surface">
              {item.tenantDisplayName}
            </h2>
            <p className="text-body-sm text-on-surface-variant">
              {item.tenantSlug} · {item.document.documentType.replaceAll('_', ' ')}
            </p>
          </div>
          <a
            href={download.url}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-outline inline-flex items-center gap-1"
            style={{ padding: '8px 16px', fontSize: '12px' }}
          >
            <span className="material-symbols-outlined text-[16px]">open_in_new</span>
            Open document
          </a>
        </div>
      </header>

      <section className="glass rounded-xl p-6">
        <h3 className="text-h3 font-h3 text-on-surface">Metadata</h3>
        <dl className="mt-4 grid grid-cols-1 gap-3 text-body-sm sm:grid-cols-2">
          <Pair k="Filename" v={item.document.originalFilename} mono />
          <Pair k="Content type" v={item.document.contentType} mono />
          <Pair
            k="Size"
            v={
              item.document.actualSizeBytes !== null
                ? `${(item.document.actualSizeBytes / 1024).toFixed(1)} KB`
                : `${(item.document.declaredSizeBytes / 1024).toFixed(1)} KB (declared)`
            }
          />
          <Pair k="SHA-256" v={item.document.sha256 ?? '—'} mono />
          <Pair k="Uploaded" v={new Date(item.document.uploadedAt).toLocaleString()} />
          <Pair
            k="Finalized"
            v={
              item.document.finalizedAt
                ? new Date(item.document.finalizedAt).toLocaleString()
                : '—'
            }
          />
          <Pair k="Current status" v={item.document.status} />
          <Pair k="SLA" v={item.document.slaState} />
        </dl>
      </section>

      <section className="glass rounded-xl p-6">
        <h3 className="text-h3 font-h3 text-on-surface">Decision</h3>
        <div className="mt-4 flex flex-wrap gap-2">
          {(['approve', 'reject', 'request_resubmission'] as KycReviewAction[]).map(
            (a) => (
              <button
                key={a}
                type="button"
                onClick={() => setAction(a)}
                className={`rounded-lg border px-3 py-2 text-body-sm font-medium transition ${
                  action === a
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-outline-variant/40 bg-white/40 text-on-surface hover:border-primary/40'
                }`}
              >
                {ACTION_LABELS[a]}
              </button>
            ),
          )}
        </div>

        <div className="mt-4 space-y-3">
          {requiresReason && (
            <label className="block space-y-1.5">
              <span className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                Rejection reason code (required)
              </span>
              <input
                list="rejection-reasons"
                type="text"
                value={reasonCode}
                onChange={(e) => setReasonCode(e.target.value)}
                maxLength={64}
                placeholder="illegible_scan"
                className="glass-input glass-input--sm font-mono"
              />
              <datalist id="rejection-reasons">
                {KYC_REJECTION_REASON_HINTS.map((r) => (
                  <option key={r} value={r} />
                ))}
              </datalist>
            </label>
          )}
          <label className="block space-y-1.5">
            <span className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
              Notes{requiresNotes ? ' (required)' : ' (optional)'}
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              maxLength={1000}
              placeholder="What does the hospital need to fix or know?"
              className="glass-input"
            />
          </label>
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={submit}
            disabled={
              submitting ||
              (requiresReason && reasonCode.trim().length === 0) ||
              (requiresNotes && notes.trim().length === 0)
            }
            className="btn-primary inline-flex items-center"
            style={{ padding: '10px 22px', fontSize: '13px' }}
          >
            <span
              className="material-symbols-outlined text-[18px]"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              gavel
            </span>
            {submitting ? 'Submitting…' : `Confirm ${ACTION_LABELS[action]}`}
          </button>
        </div>
      </section>
    </div>
  );
}

function Pair({
  k,
  v,
  mono,
}: {
  k: string;
  v: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <div>
      <dt className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
        {k}
      </dt>
      <dd className={`text-on-surface ${mono ? 'font-mono break-all' : ''}`}>{v}</dd>
    </div>
  );
}
