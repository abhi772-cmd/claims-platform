'use client';

import {
  type TenantAdminListItem,
  type TenantLifecycleState,
  type TenantPrimaryAdminSummary,
} from '@claims/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { TenantAdminApi } from '../../../../lib/api/tenant-admin.api';

const LIFECYCLE_BADGE: Record<TenantLifecycleState, { label: string; cls: string }> = {
  CONTRACTED: { label: 'Contracted', cls: 'border-blue-100 bg-blue-50 text-blue-700' },
  PROVISIONING: {
    label: 'Provisioning',
    cls: 'border-blue-100 bg-blue-50 text-blue-700',
  },
  IN_SETUP: {
    label: 'In setup',
    cls: 'border-amber-100 bg-amber-50 text-amber-700',
  },
  PILOT: {
    label: 'Pilot',
    cls: 'border-indigo-100 bg-indigo-50 text-indigo-700',
  },
  LIVE: { label: 'Live', cls: 'border-green-100 bg-green-50 text-green-700' },
  SUSPENDED: {
    label: 'Suspended',
    cls: 'border-red-100 bg-red-50 text-red-700',
  },
  CHURNED: {
    label: 'Churned',
    cls: 'border-stone-100 bg-stone-100 text-stone-700',
  },
};

export default function TenantsAdminPage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const router = useRouter();
  const [items, setItems] = useState<TenantAdminListItem[] | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  async function reload(): Promise<void> {
    try {
      const out = await TenantAdminApi.list();
      setItems(out.items);
    } catch (err) {
      showApiError(err);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onResend(tenantId: string, userId: string): Promise<void> {
    setResendingId(userId);
    try {
      const out = await TenantAdminApi.resendPrimaryInvite(tenantId, userId);
      const expires = new Date(out.inviteExpiresAt).toLocaleString();
      setToast(`Invite resent. New expiry: ${expires}`);
      // Reload to pick up the fresh expiry on the row.
      await reload();
    } catch (err) {
      showApiError(err);
    } finally {
      setResendingId(null);
      // Auto-dismiss the toast after 6s.
      setTimeout(() => setToast(null), 6000);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6">
      <header className="glass flex flex-wrap items-center justify-between gap-4 rounded-xl p-6">
        <div>
          <h2 className="text-h2 font-h2 text-on-surface">Hospitals</h2>
          <p className="mt-1 max-w-2xl text-body text-on-surface-variant">
            DigiSparsh ops portal — every onboarded hospital lives here. Click{' '}
            <span className="font-semibold">New hospital</span> to provision a new
            tenant and send the invite to its primary admin in one step.
          </p>
        </div>
        <Link
          href="/admin/tenants/new"
          className="btn-primary inline-flex items-center"
          style={{ padding: '8px 18px', fontSize: '13px' }}
        >
          <span
            className="material-symbols-outlined text-[18px]"
            style={{ fontVariationSettings: "'FILL' 1" }}
          >
            domain_add
          </span>
          New hospital
        </Link>
      </header>

      {toast && (
        <div className="rounded-lg border border-green-200 bg-green-50/70 px-4 py-2 text-body-sm text-green-700">
          {toast}
        </div>
      )}

      <section className="glass overflow-x-auto rounded-xl">
        {items === null ? (
          <p className="p-6 text-body text-on-surface-variant">Loading hospitals…</p>
        ) : items.length === 0 ? (
          <p className="p-6 text-body text-on-surface-variant">
            No hospitals yet. Click <span className="font-semibold">New hospital</span> to
            create the first one.
          </p>
        ) : (
          <table className="min-w-full">
            <thead className="border-b border-outline-variant/40 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
              <tr>
                <th className="px-4 py-3 text-left">Hospital</th>
                <th className="px-4 py-3 text-left">Lifecycle</th>
                <th className="px-4 py-3 text-left">Primary admin</th>
                <th className="px-4 py-3 text-left">Users</th>
                <th className="px-4 py-3 text-left">Created</th>
                <th className="px-4 py-3 text-right" />
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr
                  key={t.id}
                  className="cursor-pointer border-b border-outline-variant/20 last:border-b-0 hover:bg-primary/5"
                  onClick={() => router.push(`/admin/tenants/${t.id}`)}
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-on-surface">{t.displayName}</div>
                    <div className="font-mono text-body-sm text-on-surface-variant">
                      {t.slug}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-body-sm font-medium ${LIFECYCLE_BADGE[t.lifecycleState].cls}`}
                    >
                      {LIFECYCLE_BADGE[t.lifecycleState].label}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <PrimaryAdminCell admin={t.primaryAdmin} />
                  </td>
                  <td className="px-4 py-3 font-mono tabular-nums text-body-sm text-on-surface-variant">
                    {t.activeUserCount}
                  </td>
                  <td className="px-4 py-3 text-body-sm text-on-surface-variant">
                    {new Date(t.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {t.primaryAdmin && t.primaryAdmin.status === 'invited' && (
                      <button
                        type="button"
                        onClick={(e) => {
                          // Don't navigate when clicking the action button.
                          e.stopPropagation();
                          void onResend(t.id, t.primaryAdmin!.id);
                        }}
                        disabled={resendingId === t.primaryAdmin.id}
                        className="btn-outline inline-flex items-center"
                        style={{ padding: '6px 12px', fontSize: '12px' }}
                      >
                        <span className="material-symbols-outlined text-[16px]">
                          mark_email_unread
                        </span>
                        {resendingId === t.primaryAdmin.id ? 'Sending…' : 'Resend invite'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function PrimaryAdminCell({
  admin,
}: {
  admin: TenantPrimaryAdminSummary | null;
}): JSX.Element {
  if (!admin) {
    return (
      <span className="text-body-sm text-on-surface-variant">
        <span className="font-mono">—</span> (seed tenant)
      </span>
    );
  }
  const isPending = admin.status === 'invited';
  const tag = isPending
    ? admin.inviteExpired
      ? {
          label: 'Invite expired',
          cls: 'border-red-100 bg-red-50 text-red-700',
        }
      : {
          label: 'Awaiting acceptance',
          cls: 'border-amber-100 bg-amber-50 text-amber-700',
        }
    : admin.status === 'active'
      ? {
          label: 'Active',
          cls: 'border-green-100 bg-green-50 text-green-700',
        }
      : {
          label: admin.status,
          cls: 'border-stone-100 bg-stone-100 text-stone-700',
        };
  return (
    <div className="flex flex-col gap-1">
      <div className="font-medium text-on-surface">
        {admin.firstName} {admin.lastName}
      </div>
      <div className="text-body-sm text-on-surface-variant">{admin.email}</div>
      <div className="mt-0.5 flex items-center gap-2">
        <span
          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${tag.cls}`}
        >
          {tag.label}
        </span>
        {isPending && admin.inviteExpiresAt && !admin.inviteExpired && (
          <span className="text-body-sm text-on-surface-variant">
            expires {new Date(admin.inviteExpiresAt).toLocaleDateString()}
          </span>
        )}
      </div>
    </div>
  );
}
