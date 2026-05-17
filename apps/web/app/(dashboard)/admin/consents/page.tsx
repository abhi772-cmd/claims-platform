'use client';

// Slice BT — DPDP consent record viewer.

import {
  type ConsentListFilter,
  type ConsentRecordRow,
  type ConsentStatus,
  type ConsentType,
} from '@claims/contracts';
import { useEffect, useState } from 'react';

import { usePrompt } from '../../../../components/modals/ConfirmDialog/ConfirmDialogProvider';
import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { useToast } from '../../../../components/toast/ToastProvider';
import { ConsentApi } from '../../../../lib/api/consent.api';

const TYPES: ConsentType[] = ['nhcx_processing', 'pmjay_processing', 'analytics', 'communication'];
const STATUSES: ConsentStatus[] = ['granted', 'withdrawn', 'expired', 'superseded'];

const STATUS_STYLE: Record<ConsentStatus, { cls: string; dot: string }> = {
  granted: { cls: 'bg-green-50 text-green-700 border-green-100', dot: 'bg-green-500' },
  withdrawn: { cls: 'bg-red-50 text-red-700 border-red-100', dot: 'bg-red-500' },
  expired: { cls: 'bg-surface-container text-on-surface-variant border-outline-variant/50', dot: 'bg-outline' },
  superseded: { cls: 'bg-amber-50 text-amber-700 border-amber-100', dot: 'bg-amber-500' },
};

export default function ConsentsViewerPage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const prompt = usePrompt();
  const showToast = useToast();
  const [filter, setFilter] = useState<ConsentListFilter>({});
  const [draft, setDraft] = useState<ConsentListFilter>({});
  const [rows, setRows] = useState<ConsentRecordRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    ConsentApi.list(filter)
      .then((out) => {
        if (cancelled) return;
        setRows(out.rows);
        setTotal(out.total);
      })
      .catch((err) => showApiError(err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filter, refreshKey, showApiError]);

  const apply = (): void => setFilter(draft);

  const withdraw = async (id: string): Promise<void> => {
    const reason = await prompt({
      title: 'Withdraw consent',
      body: 'The data subject is exercising their right to withdraw under DPDP §6. The withdrawal is recorded in the audit log and stops new data processing tied to this consent.',
      label: 'Reason for withdrawal',
      placeholder: 'e.g. Data subject requested withdrawal by email on 2026-05-17.',
      minLength: 5,
      maxLength: 2000,
      multiline: true,
      confirmLabel: 'Withdraw consent',
    });
    if (reason === null) return;
    try {
      await ConsentApi.withdraw(id, { reason });
      showToast({ tone: 'success', message: 'Consent withdrawn.' });
      setRefreshKey((k) => k + 1);
    } catch (err) {
      showApiError(err);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6">
      <header className="glass rounded-xl p-6">
        <h2 className="text-h2 font-h2 text-on-surface">Consent records</h2>
        <p className="mt-1 text-body text-on-surface-variant">
          DPDP Act 2023 §6 / Rule 8 — operator-captured grants and withdrawals.
        </p>
      </header>

      {/* Filters */}
      <section className="glass rounded-xl p-6">
        <div className="mb-4 flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">filter_alt</span>
          <h3 className="text-h3 font-h3 text-on-surface">Filter</h3>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input
            type="text"
            placeholder="Patient id (uuid)"
            value={draft.patientId ?? ''}
            onChange={(e) => setDraft({ ...draft, patientId: e.target.value || undefined })}
            className="glass-input glass-input--sm font-mono"
          />
          <div className="relative">
            <select
              value={draft.consentType ?? ''}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  consentType: (e.target.value || undefined) as ConsentType | undefined,
                })
              }
              className="glass-input glass-input--sm appearance-none pr-10"
            >
              <option value="">All types</option>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <span className="material-symbols-outlined pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[18px] text-on-surface-variant">
              expand_more
            </span>
          </div>
          <div className="relative">
            <select
              value={draft.status ?? ''}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  status: (e.target.value || undefined) as ConsentStatus | undefined,
                })
              }
              className="glass-input glass-input--sm appearance-none pr-10"
            >
              <option value="">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <span className="material-symbols-outlined pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[18px] text-on-surface-variant">
              expand_more
            </span>
          </div>
          <button
            type="button"
            onClick={apply}
            className="btn-primary"
            style={{ padding: '10px 22px', fontSize: '13px' }}
          >
            <span className="material-symbols-outlined text-[18px]">search</span>
            Apply filter
          </button>
        </div>
      </section>

      {/* Table */}
      <section className="glass flex flex-col overflow-hidden rounded-xl">
        <div className="flex items-center justify-between border-b border-surface-variant/50 bg-white/30 px-6 py-4">
          <h3 className="flex items-center gap-2 text-body font-semibold text-on-surface">
            <span className="material-symbols-outlined text-primary">task_alt</span>
            Records
          </h3>
          <span className="text-body-sm text-on-surface-variant">
            {loading ? '…' : `Showing ${rows.length} of ${total}`}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead className="bg-primary/5">
              <tr>
                <th className="px-6 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                  Granted
                </th>
                <th className="px-6 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                  Patient
                </th>
                <th className="px-6 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                  Type
                </th>
                <th className="px-6 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                  Status
                </th>
                <th className="px-6 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                  Lawful basis
                </th>
                <th className="px-6 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                  Source
                </th>
                <th className="px-6 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                  Expires
                </th>
                <th className="px-6 py-3 text-right text-eyebrow uppercase tracking-eyebrow text-on-surface-variant" />
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-variant/30">
              {rows.map((r) => {
                const s = STATUS_STYLE[r.status];
                return (
                  <tr key={r.id} className="transition-colors hover:bg-primary/5">
                    <td className="px-6 py-3 text-body-sm text-on-surface">
                      {new Date(r.grantedAt).toLocaleString()}
                    </td>
                    <td className="px-6 py-3 font-mono text-body-sm text-primary">
                      {r.patientId.slice(0, 8)}
                    </td>
                    <td className="px-6 py-3 font-mono text-body-sm text-on-surface">
                      {r.consentType}
                    </td>
                    <td className="px-6 py-3">
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-body-sm font-medium ${s.cls}`}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
                        {r.status}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-body-sm text-on-surface-variant">
                      {r.lawfulBasis}
                    </td>
                    <td className="px-6 py-3 text-body-sm text-on-surface-variant">{r.source}</td>
                    <td className="px-6 py-3 text-body-sm text-on-surface-variant">
                      {r.expiresAt ? new Date(r.expiresAt).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-6 py-3 text-right">
                      {r.status === 'granted' && (
                        <button
                          type="button"
                          onClick={() => void withdraw(r.id)}
                          className="inline-flex items-center gap-1 rounded-full border border-error/40 px-3 py-1.5 text-body-sm font-semibold text-error transition hover:bg-error/5"
                        >
                          <span className="material-symbols-outlined text-[16px]">cancel</span>
                          Withdraw
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && !loading && (
          <p className="px-6 py-10 text-center text-body-sm text-on-surface-variant">
            No matching consent records.
          </p>
        )}
        {loading && (
          <p className="px-6 py-10 text-center text-body-sm text-on-surface-variant">
            Loading…
          </p>
        )}
      </section>
    </div>
  );
}
