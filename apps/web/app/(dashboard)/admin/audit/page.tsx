'use client';

import {
  type AuditLogEntry,
  type AuditLogFilter,
  type TenantUserSummary,
} from '@claims/contracts';
import { useEffect, useState } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { AuditApi } from '../../../../lib/api/audit.api';
import { TenantUsersApi } from '../../../../lib/api/tenant-users.api';

const DEFAULT_LIMIT = 50;

export default function AuditViewerPage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const [filter, setFilter] = useState<AuditLogFilter>({});
  const [draft, setDraft] = useState<AuditLogFilter>({});
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  // Row expansion — only one row open at a time keeps the table
  // height stable. Click again on the open row to collapse.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Actor name lookup — loaded once per page mount. The audit
  // log carries actorUserId only; this map gives the visible
  // table a real name instead of `user:1234abcd`. Missing or
  // failed fetches fall back to the id-prefix display so the
  // table still renders.
  const [actorById, setActorById] = useState<Map<string, TenantUserSummary>>(
    () => new Map(),
  );

  useEffect(() => {
    let cancelled = false;
    TenantUsersApi.list()
      .then((res) => {
        if (cancelled) return;
        const map = new Map<string, TenantUserSummary>();
        for (const u of res.users) map.set(u.id, u);
        setActorById(map);
      })
      .catch(() => {
        // Silent — the audit table still renders with id-prefix
        // fallback if the user-list call fails (e.g. operator
        // doesn't have user.invite permission).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    AuditApi.list({ ...filter, limit: DEFAULT_LIMIT, offset })
      .then((out) => {
        if (cancelled) return;
        setEntries(out.entries);
        setTotal(out.total);
        // Collapse any stale expansion when the page changes.
        setExpandedId(null);
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
                <th className="w-8 px-3 py-3" aria-label="Expand toggle" />
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
                <AuditRow
                  key={e.id}
                  entry={e}
                  actor={
                    e.actorUserId ? actorById.get(e.actorUserId) ?? null : null
                  }
                  expanded={expandedId === e.id}
                  onToggle={() =>
                    setExpandedId((cur) => (cur === e.id ? null : e.id))
                  }
                />
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

// Audit-log row + its expansion drawer.
//
// Collapsed: identical to the prior column layout — time / actor /
// action / resource / correlation.
//
// Expanded: a colspan'd second row beneath carrying full
// timestamp, full resource id, IP + user agent, the before/after
// JSON snapshots pretty-printed, and the resolved actor email
// when we have it. Click anywhere on the collapsed row to toggle.
function AuditRow({
  entry,
  actor,
  expanded,
  onToggle,
}: {
  entry: AuditLogEntry;
  actor: TenantUserSummary | null;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  const actorLabel = (() => {
    if (actor) return `${actor.firstName} ${actor.lastName}`.trim() || actor.email;
    if (entry.actorUserId)
      return `${entry.actorType}:${entry.actorUserId.slice(0, 8)}…`;
    return entry.actorType;
  })();

  return (
    <>
      <tr
        className="cursor-pointer transition-colors hover:bg-primary/5"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <td className="px-3 py-3 align-middle text-on-surface-variant">
          <span
            className={`material-symbols-outlined text-[18px] transition-transform ${expanded ? 'rotate-90' : ''}`}
          >
            chevron_right
          </span>
        </td>
        <td className="px-6 py-3 text-body-sm text-on-surface">
          {new Date(entry.occurredAt).toLocaleString()}
        </td>
        <td className="px-6 py-3 text-body-sm text-on-surface">
          {actorLabel}
          {actor ? (
            <span className="ml-1 text-[11px] text-on-surface-variant">
              ({entry.actorType})
            </span>
          ) : null}
        </td>
        <td className="px-6 py-3 font-mono text-body-sm text-primary">
          {entry.action}
        </td>
        <td className="px-6 py-3 text-body-sm text-on-surface">
          {entry.resourceType}
          {entry.resourceId ? ` / ${entry.resourceId.slice(0, 8)}…` : ''}
        </td>
        <td className="px-6 py-3 font-mono text-body-sm text-on-surface-variant">
          {entry.correlationId ?? '—'}
        </td>
      </tr>
      {expanded ? (
        <tr className="bg-surface-container-lowest/40">
          <td colSpan={6} className="px-6 py-4">
            <ExpandedDetail entry={entry} actor={actor} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function ExpandedDetail({
  entry,
  actor,
}: {
  entry: AuditLogEntry;
  actor: TenantUserSummary | null;
}): JSX.Element {
  return (
    <div className="space-y-4 text-body-sm">
      {/* Top metadata grid — full timestamp + resource id + actor
          contact + correlation, things the collapsed row truncates. */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        <DetailCell label="Occurred">
          <span className="font-mono">
            {new Date(entry.occurredAt).toISOString()}
          </span>
        </DetailCell>
        <DetailCell label="Resource">
          <span className="font-mono">{entry.resourceType}</span>
          {entry.resourceId ? (
            <>
              <span className="text-on-surface-variant"> · </span>
              <span className="font-mono text-[11px] text-on-surface-variant">
                {entry.resourceId}
              </span>
            </>
          ) : null}
        </DetailCell>
        <DetailCell label="Actor">
          {actor ? (
            <>
              <div className="font-medium">
                {actor.firstName} {actor.lastName}
              </div>
              <div className="text-[11px] text-on-surface-variant">
                {actor.email}
              </div>
            </>
          ) : entry.actorUserId ? (
            <span className="font-mono text-[11px] text-on-surface-variant">
              {entry.actorUserId}
            </span>
          ) : (
            <span className="text-on-surface-variant">
              {entry.actorType} (no user id)
            </span>
          )}
        </DetailCell>
        <DetailCell label="Correlation">
          <span className="font-mono text-[11px]">
            {entry.correlationId ?? '—'}
          </span>
        </DetailCell>
      </div>

      {/* Network metadata — IP + user agent. Operators / reviewers
          use these to spot suspicious actors or to triage a
          report. Truncate the UA so the row doesn't blow up but
          keep the full string in the title attribute. */}
      {(entry.ipAddress || entry.userAgent) && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[12px] text-on-surface-variant">
          {entry.ipAddress ? (
            <span>
              IP <span className="font-mono text-on-surface">{entry.ipAddress}</span>
            </span>
          ) : null}
          {entry.userAgent ? (
            <span
              className="min-w-0 flex-1 truncate"
              title={entry.userAgent}
            >
              UA{' '}
              <span className="font-mono text-on-surface">
                {entry.userAgent}
              </span>
            </span>
          ) : null}
        </div>
      )}

      {/* Before / after snapshots. Service redacts known-PII keys
          before persistence, so what we render is safe. We use a
          two-column diff-style layout when both sides are present;
          a single-column layout when only one side is. */}
      {entry.before !== null || entry.after !== null ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {entry.before !== null ? (
            <SnapshotBlock label="Before" value={entry.before} />
          ) : null}
          {entry.after !== null ? (
            <SnapshotBlock label="After" value={entry.after} />
          ) : null}
        </div>
      ) : (
        <p className="text-[12px] italic text-on-surface-variant">
          No before / after snapshot captured for this action.
        </p>
      )}
    </div>
  );
}

function DetailCell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-outline-variant/30 bg-surface-container-lowest/60 p-3">
      <p className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
        {label}
      </p>
      <div className="mt-1 break-all text-body-sm text-on-surface">{children}</div>
    </div>
  );
}

function SnapshotBlock({
  label,
  value,
}: {
  label: string;
  value: unknown;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-outline-variant/30 bg-[#1A1D1E] p-3">
      <p className="mb-2 text-eyebrow uppercase tracking-eyebrow text-[#7E8B92]">
        {label}
      </p>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[#A0AAB0]">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
