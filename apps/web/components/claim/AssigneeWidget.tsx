'use client';

// Tier 2 — claim assignment widget on case detail.
//
// Renders the current assignee as a pill ("Unassigned" when null
// or "AB" initials + name when set). Click opens an inline
// dropdown of tenant users. Picking one POSTs the assign endpoint
// and shows a success toast. "Unassign" clears.
//
// User list is loaded lazily — first click triggers the fetch via
// TenantUsersApi.list. Subsequent opens use the cached map.
//
// Permission gate: only operators with the `case.assign`
// permission see the edit affordance. We don't have a clean
// client-side permission check (no /me/permissions endpoint
// surfaced as such), so we surface the dropdown to everyone and
// let the server's 403 propagate via showApiError. Wrong from a
// UX-purist angle but matches the rest of the app's pattern.

import { type TenantUserSummary } from '@claims/contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';
import { useToast } from '../toast/ToastProvider';
import { CaseApi } from '../../lib/api/case.api';
import { TenantUsersApi } from '../../lib/api/tenant-users.api';

interface Props {
  caseId: string;
  claimId: string;
  assignedToUserId: string | null;
  onChanged: () => void;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : '')).toUpperCase();
}

export function AssigneeWidget({
  caseId,
  claimId,
  assignedToUserId,
  onChanged,
}: Props): JSX.Element {
  const { showApiError } = useErrorModal();
  const showToast = useToast();
  const [users, setUsers] = useState<TenantUserSummary[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');

  // Load tenant users lazily on first open. Silent failure —
  // the operator can still see the current assignee, just can't
  // change it. Lacks permission is the typical cause.
  useEffect(() => {
    if (!open || users !== null) return;
    let cancelled = false;
    TenantUsersApi.list()
      .then((res) => {
        if (!cancelled) setUsers(res.users);
      })
      .catch(() => {
        if (!cancelled) setUsers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, users]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const currentUser = useMemo(() => {
    if (!users || !assignedToUserId) return null;
    return users.find((u) => u.id === assignedToUserId) ?? null;
  }, [users, assignedToUserId]);

  const filtered = useMemo(() => {
    if (!users) return [];
    const term = search.trim().toLowerCase();
    if (term.length === 0) {
      return users.filter((u) => u.status === 'active');
    }
    return users.filter(
      (u) =>
        u.status === 'active' &&
        `${u.firstName} ${u.lastName} ${u.email}`.toLowerCase().includes(term),
    );
  }, [users, search]);

  const assign = useCallback(
    async (userId: string | null, label: string) => {
      setBusy(true);
      try {
        await CaseApi.assignClaim(caseId, claimId, userId);
        showToast({
          tone: 'success',
          message: userId === null ? 'Claim unassigned.' : `Assigned to ${label}.`,
        });
        setOpen(false);
        setSearch('');
        onChanged();
      } catch (err) {
        showApiError(err);
      } finally {
        setBusy(false);
      }
    },
    [caseId, claimId, onChanged, showApiError, showToast],
  );

  const displayLabel = (() => {
    if (!assignedToUserId) return 'Unassigned';
    if (currentUser) return `${currentUser.firstName} ${currentUser.lastName}`.trim();
    // We have an id but haven't loaded users yet — show a short id stub.
    return `User ${assignedToUserId.slice(0, 8)}…`;
  })();

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className={
          assignedToUserId
            ? 'inline-flex items-center gap-2 rounded-full border border-primary-fixed-dim/40 bg-primary-fixed-dim/15 px-2.5 py-1 text-body-sm font-medium text-on-surface hover:border-primary/40'
            : 'inline-flex items-center gap-2 rounded-full border border-outline-variant/40 bg-surface-container-lowest/70 px-2.5 py-1 text-body-sm text-on-surface-variant hover:border-primary/40 hover:text-on-surface'
        }
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Click to assign / re-assign / unassign"
      >
        {assignedToUserId && currentUser ? (
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-on-primary">
            {initials(`${currentUser.firstName} ${currentUser.lastName}`)}
          </span>
        ) : (
          <span className="material-symbols-outlined text-[16px]">person</span>
        )}
        <span className="max-w-[160px] truncate">{displayLabel}</span>
        <span className="material-symbols-outlined text-[14px] opacity-60">
          expand_more
        </span>
      </button>

      {open ? (
        <div
          className="absolute right-0 top-full z-modal mt-1 w-72 rounded-xl border border-outline-variant/40 bg-white p-2 shadow-lg"
          role="listbox"
        >
          <div className="relative mb-1.5">
            <span
              aria-hidden
              className="material-symbols-outlined pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[16px] text-on-surface-variant"
            >
              search
            </span>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or email…"
              autoFocus
              className="w-full rounded-md border border-outline-variant/40 bg-surface-container-lowest/60 py-1.5 pl-7 pr-2 text-body-sm text-on-surface outline-none focus:border-primary focus:ring-1 focus:ring-primary-container"
            />
          </div>

          {users === null ? (
            <p className="px-2 py-3 text-[12px] text-on-surface-variant">Loading…</p>
          ) : filtered.length === 0 ? (
            <p className="px-2 py-3 text-[12px] text-on-surface-variant">
              No active users match.
            </p>
          ) : (
            <ul className="max-h-64 overflow-y-auto">
              {filtered.map((u) => {
                const selected = u.id === assignedToUserId;
                return (
                  <li key={u.id}>
                    <button
                      type="button"
                      onClick={() =>
                        void assign(u.id, `${u.firstName} ${u.lastName}`.trim())
                      }
                      disabled={busy || selected}
                      className={
                        selected
                          ? 'flex w-full items-center gap-2 rounded-md bg-primary/10 px-2 py-1.5 text-left text-body-sm text-primary'
                          : 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-body-sm text-on-surface hover:bg-primary/5'
                      }
                      role="option"
                      aria-selected={selected}
                    >
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-fixed-dim/30 text-[10px] font-bold text-primary">
                        {initials(`${u.firstName} ${u.lastName}`)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">
                          {u.firstName} {u.lastName}
                        </span>
                        <span className="block truncate text-[11px] text-on-surface-variant">
                          {u.email}
                        </span>
                      </span>
                      {selected ? (
                        <span className="material-symbols-outlined text-[16px] text-primary">
                          check
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {assignedToUserId ? (
            <div className="mt-1.5 border-t border-outline-variant/30 pt-1.5">
              <button
                type="button"
                onClick={() => void assign(null, '')}
                disabled={busy}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-body-sm text-amber-700 hover:bg-amber-50"
              >
                <span className="material-symbols-outlined text-[16px]">
                  person_off
                </span>
                Unassign
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
