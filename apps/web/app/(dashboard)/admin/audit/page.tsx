'use client';

import { type AuditLogEntry, type AuditLogFilter } from '@claims/contracts';
import { useEffect, useState } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { AuditApi } from '../../../../lib/api/audit.api';

const DEFAULT_LIMIT = 50;

export default function AuditViewerPage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const [filter, setFilter] = useState<AuditLogFilter>({});
  const [draft, setDraft] = useState<AuditLogFilter>({});
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    AuditApi.list({ ...filter, limit: DEFAULT_LIMIT, offset })
      .then((out) => {
        if (cancelled) return;
        setEntries(out.entries);
        setTotal(out.total);
      })
      .catch((err) => showApiError(err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filter, offset, showApiError]);

  const apply = (): void => {
    setOffset(0);
    setFilter(draft);
  };

  const exportCsv = (): void => {
    window.open(AuditApi.exportUrl(filter), '_blank');
  };

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6">
      <header className="glass flex flex-col items-start justify-between gap-4 rounded-xl p-6 md:flex-row md:items-center">
        <div>
          <h2 className="text-h2 font-h2 text-on-surface">Audit log</h2>
          <p className="mt-1 text-body text-on-surface-variant">
            Tenant-scoped, append-only. Every privileged action and data access is recorded
            here.
          </p>
        </div>
        <button
          type="button"
          onClick={exportCsv}
          className="btn-outline"
          style={{ padding: '10px 22px', fontSize: '13px' }}
        >
          <span className="material-symbols-outlined text-[18px]">download</span>
          Export CSV
        </button>
      </header>

      {/* Filters */}
      <section className="glass rounded-xl p-6">
        <div className="mb-4 flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">filter_alt</span>
          <h3 className="text-h3 font-h3 text-on-surface">Filter</h3>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <input
            type="datetime-local"
            value={draft.from?.slice(0, 16) ?? ''}
            onChange={(e) =>
              setDraft({
                ...draft,
                from: e.target.value ? new Date(e.target.value).toISOString() : undefined,
              })
            }
            className="glass-input glass-input--sm"
          />
          <input
            type="datetime-local"
            value={draft.to?.slice(0, 16) ?? ''}
            onChange={(e) =>
              setDraft({
                ...draft,
                to: e.target.value ? new Date(e.target.value).toISOString() : undefined,
              })
            }
            className="glass-input glass-input--sm"
          />
          <input
            type="text"
            placeholder="Action (e.g. user.login)"
            value={draft.action ?? ''}
            onChange={(e) => setDraft({ ...draft, action: e.target.value || undefined })}
            className="glass-input glass-input--sm font-mono"
          />
          <input
            type="text"
            placeholder="Resource type (e.g. case)"
            value={draft.resourceType ?? ''}
            onChange={(e) =>
              setDraft({ ...draft, resourceType: e.target.value || undefined })
            }
            className="glass-input glass-input--sm font-mono"
          />
          <input
            type="text"
            placeholder="Correlation id"
            value={draft.correlationId ?? ''}
            onChange={(e) =>
              setDraft({ ...draft, correlationId: e.target.value || undefined })
            }
            className="glass-input glass-input--sm font-mono"
          />
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
            <span className="material-symbols-outlined text-primary">manage_search</span>
            Entries
          </h3>
          <span className="text-body-sm text-on-surface-variant">
            {loading
              ? '…'
              : `${entries.length === 0 ? 0 : offset + 1}–${offset + entries.length} of ${total}`}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead className="bg-primary/5">
              <tr>
                <th className="px-6 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                  Time
                </th>
                <th className="px-6 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                  Actor
                </th>
                <th className="px-6 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                  Action
                </th>
                <th className="px-6 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                  Resource
                </th>
                <th className="px-6 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                  Correlation
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-variant/30">
              {entries.map((e) => (
                <tr key={e.id} className="transition-colors hover:bg-primary/5">
                  <td className="px-6 py-3 text-body-sm text-on-surface">
                    {new Date(e.occurredAt).toLocaleString()}
                  </td>
                  <td className="px-6 py-3 text-body-sm text-on-surface">
                    {e.actorUserId
                      ? `${e.actorType}:${e.actorUserId.slice(0, 8)}`
                      : e.actorType}
                  </td>
                  <td className="px-6 py-3 font-mono text-body-sm text-primary">{e.action}</td>
                  <td className="px-6 py-3 text-body-sm text-on-surface">
                    {e.resourceType}
                    {e.resourceId ? ` / ${e.resourceId.slice(0, 8)}` : ''}
                  </td>
                  <td className="px-6 py-3 font-mono text-body-sm text-on-surface-variant">
                    {e.correlationId ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {entries.length === 0 && !loading && (
          <p className="px-6 py-10 text-center text-body-sm text-on-surface-variant">
            No matching audit entries.
          </p>
        )}
        {loading && (
          <p className="px-6 py-10 text-center text-body-sm text-on-surface-variant">
            Loading…
          </p>
        )}
      </section>

      {/* Pagination */}
      <section className="flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - DEFAULT_LIMIT))}
          className="btn-outline"
          style={{ padding: '8px 18px', fontSize: '13px' }}
        >
          <span className="material-symbols-outlined text-[18px]">chevron_left</span>
          Previous
        </button>
        <button
          type="button"
          disabled={offset + entries.length >= total}
          onClick={() => setOffset(offset + DEFAULT_LIMIT)}
          className="btn-outline"
          style={{ padding: '8px 18px', fontSize: '13px' }}
        >
          Next
          <span className="material-symbols-outlined text-[18px]">chevron_right</span>
        </button>
      </section>
    </div>
  );
}
