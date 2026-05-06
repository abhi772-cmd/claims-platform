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
    <div className="space-y-4 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Audit log</h1>
        <button
          type="button"
          onClick={exportCsv}
          className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
        >
          Export CSV
        </button>
      </header>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <input
          type="datetime-local"
          placeholder="From"
          value={draft.from?.slice(0, 16) ?? ''}
          onChange={(e) =>
            setDraft({
              ...draft,
              from: e.target.value ? new Date(e.target.value).toISOString() : undefined,
            })
          }
          className="rounded border px-3 py-2"
        />
        <input
          type="datetime-local"
          placeholder="To"
          value={draft.to?.slice(0, 16) ?? ''}
          onChange={(e) =>
            setDraft({
              ...draft,
              to: e.target.value ? new Date(e.target.value).toISOString() : undefined,
            })
          }
          className="rounded border px-3 py-2"
        />
        <input
          type="text"
          placeholder="Action (e.g. user.login)"
          value={draft.action ?? ''}
          onChange={(e) => setDraft({ ...draft, action: e.target.value || undefined })}
          className="rounded border px-3 py-2"
        />
        <input
          type="text"
          placeholder="Resource type (e.g. case)"
          value={draft.resourceType ?? ''}
          onChange={(e) =>
            setDraft({ ...draft, resourceType: e.target.value || undefined })
          }
          className="rounded border px-3 py-2"
        />
        <input
          type="text"
          placeholder="Correlation id"
          value={draft.correlationId ?? ''}
          onChange={(e) =>
            setDraft({ ...draft, correlationId: e.target.value || undefined })
          }
          className="rounded border px-3 py-2"
        />
        <button
          type="button"
          onClick={apply}
          className="rounded bg-gray-800 px-4 py-2 text-white hover:bg-gray-900"
        >
          Apply filter
        </button>
      </section>

      <section>
        <table className="w-full table-auto border-collapse text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left">
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">Actor</th>
              <th className="px-3 py-2">Action</th>
              <th className="px-3 py-2">Resource</th>
              <th className="px-3 py-2">Correlation</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-b hover:bg-gray-50">
                <td className="px-3 py-2">{new Date(e.occurredAt).toLocaleString()}</td>
                <td className="px-3 py-2">
                  {e.actorUserId ? `${e.actorType}:${e.actorUserId.slice(0, 8)}` : e.actorType}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{e.action}</td>
                <td className="px-3 py-2">
                  {e.resourceType}
                  {e.resourceId ? ` / ${e.resourceId.slice(0, 8)}` : ''}
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {e.correlationId ?? ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries.length === 0 && !loading && (
          <p className="py-8 text-center text-gray-500">No matching audit entries.</p>
        )}
        {loading && <p className="py-8 text-center text-gray-500">Loading…</p>}
      </section>

      <section className="flex items-center justify-between">
        <span className="text-sm text-gray-600">
          {entries.length === 0 ? 0 : offset + 1}-{offset + entries.length} of {total}
        </span>
        <div className="space-x-2">
          <button
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - DEFAULT_LIMIT))}
            className="rounded border px-3 py-1 disabled:opacity-50"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={offset + entries.length >= total}
            onClick={() => setOffset(offset + DEFAULT_LIMIT)}
            className="rounded border px-3 py-1 disabled:opacity-50"
          >
            Next
          </button>
        </div>
      </section>
    </div>
  );
}
