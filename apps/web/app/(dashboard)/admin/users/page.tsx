'use client';

// Admin /tenant/users directory.
//
// Pre-Phase-3 this was a stub that just linked to the invite
// form. The directory below lists every tenant user with their
// roles, status, and last-login so admins can scan team
// composition + spot stale accounts without exporting a CSV.
//
// Filters are client-side (search box only); the list is bounded
// by tenant size (low hundreds in the worst case) so a fuller
// server-side filter UI would be over-engineered for V1.

import {
  type RoleName,
  type TenantUserSummary,
  type UserStatus,
} from '@claims/contracts';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { TenantUsersApi } from '../../../../lib/api/tenant-users.api';

const STATUS_STYLE: Record<
  UserStatus,
  { label: string; cls: string; dot: string }
> = {
  active: {
    label: 'Active',
    cls: 'bg-green-50 text-green-700 border-green-100',
    dot: 'bg-green-500',
  },
  invited: {
    label: 'Invited',
    cls: 'bg-amber-50 text-amber-700 border-amber-100',
    dot: 'bg-amber-500',
  },
  suspended: {
    label: 'Suspended',
    cls: 'bg-red-50 text-red-700 border-red-100',
    dot: 'bg-red-500',
  },
  deactivated: {
    label: 'Deactivated',
    cls: 'bg-surface-container-high text-on-surface-variant border-outline-variant/50',
    dot: 'bg-outline',
  },
};

// Pretty-print a role token. Display layer only — the underlying
// RoleName tokens stay as-is on the wire.
const ROLE_LABEL: Record<RoleName, string> = {
  platform_admin: 'Platform admin',
  tenant_admin: 'Tenant admin',
  billing_manager: 'Billing manager',
  insurance_desk_executive: 'Insurance desk',
  pmam: 'PMAM',
  doctor: 'Doctor',
  finance_viewer: 'Finance viewer',
  read_only: 'Read-only',
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const diffMs = new Date(iso).getTime() - Date.now();
  return Math.round(diffMs / (24 * 60 * 60 * 1000));
}

export default function UsersAdminPage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const [users, setUsers] = useState<TenantUserSummary[] | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<UserStatus | 'all'>('all');
  const [resending, setResending] = useState<string | null>(null);

  async function reload(): Promise<void> {
    try {
      const out = await TenantUsersApi.list();
      setUsers(out.users);
    } catch (err) {
      showApiError(err);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    if (users === null) return [];
    const term = search.trim().toLowerCase();
    return users.filter((u) => {
      if (statusFilter !== 'all' && u.status !== statusFilter) return false;
      if (term.length === 0) return true;
      const hay = `${u.firstName} ${u.lastName} ${u.email} ${u.designation ?? ''}`.toLowerCase();
      return hay.includes(term);
    });
  }, [users, search, statusFilter]);

  const counts = useMemo(() => {
    const c = { all: 0, active: 0, invited: 0, suspended: 0, deactivated: 0 };
    for (const u of users ?? []) {
      c.all += 1;
      c[u.status] += 1;
    }
    return c;
  }, [users]);

  async function onResend(id: string): Promise<void> {
    setResending(id);
    try {
      await TenantUsersApi.resendInvite(id);
      await reload();
    } catch (err) {
      showApiError(err);
    } finally {
      setResending(null);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6">
      {/* Header — title + Invite CTA */}
      <header className="glass flex flex-col items-start justify-between gap-4 rounded-xl p-6 md:flex-row md:items-center">
        <div>
          <h2 className="text-h2 font-h2 text-on-surface">Users</h2>
          <p className="mt-1 text-body text-on-surface-variant">
            Tenant directory — invite teammates, scan roles, spot stale accounts.
          </p>
        </div>
        <Link
          href="/admin/users/invite"
          className="btn-cta"
          style={{ padding: '10px 22px' }}
        >
          <span
            className="material-symbols-outlined"
            style={{ fontSize: 20, fontVariationSettings: "'FILL' 1" }}
          >
            person_add
          </span>
          Invite a user
        </Link>
      </header>

      {/* Status filter chips + search */}
      <section className="glass flex flex-wrap items-center justify-between gap-3 rounded-xl p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusChip
            label={`All · ${counts.all}`}
            active={statusFilter === 'all'}
            onClick={() => setStatusFilter('all')}
          />
          <StatusChip
            label={`Active · ${counts.active}`}
            active={statusFilter === 'active'}
            onClick={() => setStatusFilter('active')}
          />
          <StatusChip
            label={`Invited · ${counts.invited}`}
            active={statusFilter === 'invited'}
            onClick={() => setStatusFilter('invited')}
          />
          {counts.suspended > 0 ? (
            <StatusChip
              label={`Suspended · ${counts.suspended}`}
              active={statusFilter === 'suspended'}
              onClick={() => setStatusFilter('suspended')}
            />
          ) : null}
          {counts.deactivated > 0 ? (
            <StatusChip
              label={`Deactivated · ${counts.deactivated}`}
              active={statusFilter === 'deactivated'}
              onClick={() => setStatusFilter('deactivated')}
            />
          ) : null}
        </div>
        <div className="relative">
          <span
            aria-hidden
            className="material-symbols-outlined pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[18px] text-on-surface-variant"
          >
            search
          </span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name / email / designation…"
            className="glass-input glass-input--sm w-72 pl-9"
            aria-label="Search users"
          />
        </div>
      </section>

      {/* Directory table */}
      <section className="glass rounded-xl p-2">
        {users === null ? (
          <div className="p-6">
            <p className="text-body-sm text-on-surface-variant">Loading users…</p>
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            hasAnyUsers={users.length > 0}
            search={search}
            statusFilter={statusFilter}
          />
        ) : (
          <div className="overflow-x-auto rounded-lg">
            <table className="w-full border-collapse text-left text-body-sm">
              <thead className="bg-surface-container-low/40">
                <tr>
                  <th className="px-3 py-2 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                    User
                  </th>
                  <th className="px-3 py-2 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                    Roles
                  </th>
                  <th className="px-3 py-2 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                    Status
                  </th>
                  <th className="px-3 py-2 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                    Last sign-in
                  </th>
                  <th className="px-3 py-2 text-right text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                    {' '}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((u) => (
                  <UserRow
                    key={u.id}
                    user={u}
                    resending={resending === u.id}
                    onResend={() => void onResend(u.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function StatusChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? 'rounded-full border border-primary bg-primary/10 px-3 py-1 text-body-sm font-medium text-primary'
          : 'rounded-full border border-outline-variant/40 bg-surface-container-lowest/60 px-3 py-1 text-body-sm text-on-surface-variant hover:border-primary/40 hover:text-on-surface'
      }
      aria-pressed={active}
    >
      {label}
    </button>
  );
}

function UserRow({
  user,
  resending,
  onResend,
}: {
  user: TenantUserSummary;
  resending: boolean;
  onResend: () => void;
}): JSX.Element {
  const initials = `${(user.firstName[0] ?? '').toUpperCase()}${(user.lastName[0] ?? '').toUpperCase()}`;
  const status = STATUS_STYLE[user.status];
  const days = daysUntil(user.inviteExpiresAt);
  const inviteExpired = user.status === 'invited' && days !== null && days < 0;
  return (
    <tr className="border-t border-outline-variant/20 align-top">
      <td className="px-3 py-3">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-fixed-dim/30 text-body-sm font-bold text-primary">
            {initials || '?'}
          </div>
          <div className="min-w-0">
            <p className="truncate font-medium text-on-surface">
              {user.firstName} {user.lastName}
            </p>
            <p className="truncate text-[12px] text-on-surface-variant">
              {user.email}
            </p>
            {user.designation ? (
              <p className="truncate text-[11px] text-on-surface-variant">
                {user.designation}
              </p>
            ) : null}
          </div>
        </div>
      </td>
      <td className="px-3 py-3">
        {user.roles.length === 0 ? (
          <span className="text-[12px] italic text-on-surface-variant">
            No roles
          </span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {user.roles.map((r) => (
              <span
                key={r}
                className="inline-flex items-center rounded-full border border-outline-variant/40 bg-surface-container-lowest/60 px-2 py-0.5 text-[11px] text-on-surface-variant"
              >
                {ROLE_LABEL[r] ?? r}
              </span>
            ))}
          </div>
        )}
      </td>
      <td className="px-3 py-3">
        <div className="flex flex-col gap-1.5">
          <span
            className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-body-sm font-medium ${status.cls}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
            {status.label}
          </span>
          {user.status === 'invited' && days !== null ? (
            <span
              className={
                inviteExpired
                  ? 'text-[11px] font-medium text-red-700'
                  : 'text-[11px] text-on-surface-variant'
              }
            >
              {inviteExpired ? 'invite expired' : `expires in ${days}d`}
            </span>
          ) : null}
          {user.mfaEnabled ? (
            <span className="inline-flex w-fit items-center gap-1 text-[11px] text-on-surface-variant">
              <span className="material-symbols-outlined text-[12px]">encrypted</span>
              MFA on
            </span>
          ) : null}
        </div>
      </td>
      <td className="px-3 py-3 text-[12px] text-on-surface-variant">
        {fmtDate(user.lastLoginAt)}
      </td>
      <td className="px-3 py-3 text-right">
        {user.status === 'invited' ? (
          <button
            type="button"
            onClick={onResend}
            disabled={resending}
            className="rounded-md border border-primary bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[14px]">forward_to_inbox</span>
            {resending ? 'Resending…' : 'Resend invite'}
          </button>
        ) : null}
      </td>
    </tr>
  );
}

function EmptyState({
  hasAnyUsers,
  search,
  statusFilter,
}: {
  hasAnyUsers: boolean;
  search: string;
  statusFilter: UserStatus | 'all';
}): JSX.Element {
  if (!hasAnyUsers) {
    return (
      <div className="flex flex-col items-center gap-3 p-12 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-fixed-dim/30 text-primary">
          <span className="material-symbols-outlined">group_add</span>
        </div>
        <h3 className="text-body font-semibold text-on-surface">
          No teammates yet
        </h3>
        <p className="max-w-sm text-body-sm text-on-surface-variant">
          Invite your first teammate above. Invitees get an email (and SMS if a
          mobile number is provided) to accept and set their password.
        </p>
      </div>
    );
  }
  const filtered = search.trim().length > 0 || statusFilter !== 'all';
  return (
    <div className="flex flex-col items-center gap-2 p-10 text-center">
      <span className="material-symbols-outlined text-on-surface-variant">
        filter_alt_off
      </span>
      <p className="text-body-sm text-on-surface-variant">
        {filtered
          ? 'No users match the current filter.'
          : 'No users to display.'}
      </p>
    </div>
  );
}
