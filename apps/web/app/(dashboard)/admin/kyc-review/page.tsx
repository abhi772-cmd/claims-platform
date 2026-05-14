'use client';

import {
  type KycDocumentStatus,
  type KycReviewQueueItem,
  type KycSlaState,
  KYC_SLA_TARGET_HOURS,
} from '@claims/contracts';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { KycReviewApi } from '../../../../lib/api/kyc-review.api';

// Slice ON-3 — DigiSparsh ops KYC review queue. Cross-tenant; gated
// on the kyc.review permission, which only platform_admin carries.

const PAGE_SIZE = 50;

const STATUS_OPTIONS: { value: KycDocumentStatus; label: string }[] = [
  { value: 'pending_review', label: 'Pending review' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'resubmission_requested', label: 'Resubmission requested' },
];

const SLA_BADGE: Record<KycSlaState, { label: string; cls: string }> = {
  on_track: {
    label: 'On track',
    cls: 'border-green-100 bg-green-50 text-green-700',
  },
  warning: {
    label: 'Warning',
    cls: 'border-amber-100 bg-amber-50 text-amber-700',
  },
  breached: {
    label: `Breached ${KYC_SLA_TARGET_HOURS}h SLA`,
    cls: 'border-red-100 bg-red-50 text-red-700',
  },
};

const TYPE_LABEL: Record<string, string> = {
  hospital_registration: 'Hospital reg.',
  rohini_registration: 'ROHINI reg.',
  gst_certificate: 'GST',
  pan: 'PAN',
  signatory_id: 'Signatory ID',
  cancelled_cheque: 'Cancelled cheque',
  dpa_signed: 'DPA (signed)',
  msa_signed: 'MSA (signed)',
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function KycReviewQueuePage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const [status, setStatus] = useState<KycDocumentStatus>('pending_review');
  const [items, setItems] = useState<KycReviewQueueItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    KycReviewApi.queue({ status, limit: PAGE_SIZE, offset })
      .then((out) => {
        if (cancelled) return;
        setItems(out.items);
        setTotal(out.total);
      })
      .catch((err) => showApiError(err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [status, offset, showApiError]);

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6">
      <header className="glass flex flex-col items-start justify-between gap-4 rounded-xl p-6 md:flex-row md:items-center">
        <div>
          <h2 className="text-h2 font-h2 text-on-surface">KYC review queue</h2>
          <p className="mt-1 text-body text-on-surface-variant">
            Hospital-uploaded KYC + legal agreements awaiting your review. Target SLA is{' '}
            {KYC_SLA_TARGET_HOURS}h from upload to decision.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-body-sm text-on-surface-variant">
            Status
            <div className="relative">
              <select
                value={status}
                onChange={(e) => {
                  setOffset(0);
                  setStatus(e.target.value as KycDocumentStatus);
                }}
                className="glass-input glass-input--sm appearance-none pr-10"
              >
                {STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <span className="material-symbols-outlined pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[18px] text-on-surface-variant">
                expand_more
              </span>
            </div>
          </label>
          <span className="rounded-full border border-outline-variant/50 bg-surface-container-low px-3 py-1 text-body-sm font-semibold text-on-surface-variant">
            {total} total
          </span>
        </div>
      </header>

      <section className="glass overflow-x-auto rounded-xl">
        {loading && items.length === 0 ? (
          <p className="p-6 text-body text-on-surface-variant">Loading…</p>
        ) : items.length === 0 ? (
          <p className="p-6 text-body text-on-surface-variant">
            Nothing to review with this filter. Switch filters or take a break.
          </p>
        ) : (
          <table className="min-w-full">
            <thead className="border-b border-outline-variant/40 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
              <tr>
                <th className="px-4 py-3 text-left">Tenant</th>
                <th className="px-4 py-3 text-left">Document</th>
                <th className="px-4 py-3 text-left">Filename</th>
                <th className="px-4 py-3 text-left">Uploaded</th>
                <th className="px-4 py-3 text-left">SLA</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr
                  key={it.document.id}
                  className="border-b border-outline-variant/20 last:border-b-0 hover:bg-primary/5"
                >
                  <td className="px-4 py-3">
                    <p className="font-medium text-on-surface">{it.tenantDisplayName}</p>
                    <p className="text-body-sm text-on-surface-variant">{it.tenantSlug}</p>
                  </td>
                  <td className="px-4 py-3 text-body text-on-surface">
                    {TYPE_LABEL[it.document.documentType] ?? it.document.documentType}
                  </td>
                  <td className="px-4 py-3 font-mono text-body-sm text-on-surface-variant">
                    {it.document.originalFilename}
                  </td>
                  <td className="px-4 py-3 text-body-sm text-on-surface-variant">
                    {timeAgo(it.uploadedAt)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-body-sm font-medium ${SLA_BADGE[it.document.slaState].cls}`}
                    >
                      {SLA_BADGE[it.document.slaState].label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/admin/kyc-review/${it.document.id}`}
                      className="btn-primary inline-flex items-center"
                      style={{ padding: '6px 14px', fontSize: '12px' }}
                    >
                      Review
                      <span className="material-symbols-outlined text-[16px]">
                        chevron_right
                      </span>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between">
          <span className="text-body-sm text-on-surface-variant">
            Showing {offset + 1}-{Math.min(offset + PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-outline"
              style={{ padding: '6px 14px', fontSize: '12px' }}
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </button>
            <button
              type="button"
              className="btn-outline"
              style={{ padding: '6px 14px', fontSize: '12px' }}
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
