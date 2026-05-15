'use client';

import {
  type AuditLogEntry,
  type OnboardingStep,
  type TenantAdminDetailResponse,
  type TenantLifecycleState,
  type TenantPrimaryAdminSummary,
} from '@claims/contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { useErrorModal } from '../../../../../components/modals/ErrorModal/ErrorModalProvider';
import { TenantAdminApi } from '../../../../../lib/api/tenant-admin.api';

const LIFECYCLE_BADGE: Record<TenantLifecycleState, { label: string; cls: string }> = {
  CONTRACTED: { label: 'Contracted', cls: 'border-blue-100 bg-blue-50 text-blue-700' },
  PROVISIONING: {
    label: 'Provisioning',
    cls: 'border-blue-100 bg-blue-50 text-blue-700',
  },
  IN_SETUP: { label: 'In setup', cls: 'border-amber-100 bg-amber-50 text-amber-700' },
  PILOT: { label: 'Pilot', cls: 'border-indigo-100 bg-indigo-50 text-indigo-700' },
  LIVE: { label: 'Live', cls: 'border-green-100 bg-green-50 text-green-700' },
  SUSPENDED: { label: 'Suspended', cls: 'border-red-100 bg-red-50 text-red-700' },
  CHURNED: { label: 'Churned', cls: 'border-stone-100 bg-stone-100 text-stone-700' },
};

const STEP_STATUS_BADGE: Record<
  OnboardingStep['status'],
  { label: string; cls: string }
> = {
  pending: {
    label: 'Pending',
    cls: 'border-amber-100 bg-amber-50 text-amber-700',
  },
  in_progress: {
    label: 'In progress',
    cls: 'border-blue-100 bg-blue-50 text-blue-700',
  },
  completed: {
    label: 'Completed',
    cls: 'border-green-100 bg-green-50 text-green-700',
  },
  skipped: {
    label: 'Skipped',
    cls: 'border-stone-100 bg-stone-100 text-stone-700',
  },
};

function daysSince(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

export default function TenantDetailPage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const params = useParams<{ tenantId: string }>();
  const [data, setData] = useState<TenantAdminDetailResponse | null>(null);
  const [resending, setResending] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  async function reload(): Promise<void> {
    if (!params.tenantId) return;
    try {
      const out = await TenantAdminApi.detail(params.tenantId);
      setData(out);
    } catch (err) {
      showApiError(err);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.tenantId]);

  async function onResend(): Promise<void> {
    if (!data?.primaryAdmin) return;
    setResending(true);
    try {
      const out = await TenantAdminApi.resendPrimaryInvite(
        data.tenant.id,
        data.primaryAdmin.id,
      );
      setToast(
        `Invite resent. New expiry: ${new Date(out.inviteExpiresAt).toLocaleString()}`,
      );
      await reload();
    } catch (err) {
      showApiError(err);
    } finally {
      setResending(false);
      setTimeout(() => setToast(null), 6000);
    }
  }

  if (!data) {
    return (
      <div className="glass max-w-md rounded-xl p-6">
        <p className="text-body text-on-surface-variant">Loading hospital…</p>
      </div>
    );
  }

  const { tenant, primaryAdmin, activeUserCount, invitedUserCount, onboardingSteps, recentActivity } =
    data;
  const stepsDone = onboardingSteps.filter(
    (s) => s.status === 'completed' || s.status === 'skipped',
  ).length;
  const stepsPct = onboardingSteps.length
    ? Math.round((stepsDone / onboardingSteps.length) * 100)
    : 0;

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-6">
      <header className="glass rounded-xl p-6">
        <Link
          href="/admin/tenants"
          className="text-body-sm font-medium text-primary hover:underline"
        >
          ← Back to hospitals
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-h2 font-h2 text-on-surface">{tenant.displayName}</h2>
            <p className="font-mono text-body-sm text-on-surface-variant">
              {tenant.slug} · created {daysSince(tenant.createdAt)}d ago
            </p>
          </div>
          <span
            className={`inline-flex items-center rounded-full border px-3 py-1 text-body-sm font-semibold ${LIFECYCLE_BADGE[tenant.lifecycleState].cls}`}
          >
            {LIFECYCLE_BADGE[tenant.lifecycleState].label}
          </span>
        </div>
      </header>

      {toast && (
        <div className="rounded-lg border border-green-200 bg-green-50/70 px-4 py-2 text-body-sm text-green-700">
          {toast}
        </div>
      )}

      <section className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <Stat label="Onboarding" value={`${stepsPct}%`} hint={`${stepsDone} / ${onboardingSteps.length} steps`} />
        <Stat
          label="Active users"
          value={String(activeUserCount)}
          hint={invitedUserCount > 0 ? `${invitedUserCount} invited` : 'none invited'}
        />
        <Stat
          label="Lifecycle state"
          value={LIFECYCLE_BADGE[tenant.lifecycleState].label}
          hint={`since update ${daysSince(tenant.updatedAt)}d ago`}
        />
      </section>

      <PrimaryAdminPanel
        admin={primaryAdmin}
        onResend={onResend}
        resending={resending}
      />

      <section className="glass rounded-xl p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-h3 font-h3 text-on-surface">Onboarding steps</h3>
            <p className="mt-1 text-body-sm text-on-surface-variant">
              Read-only view of the tenant&apos;s wizard. The hospital advances steps via
              their own onboarding page.
            </p>
          </div>
          <span className="rounded-full border border-outline-variant/50 bg-surface-container-low px-3 py-1 text-body-sm font-semibold text-on-surface-variant">
            {stepsDone}/{onboardingSteps.length}
          </span>
        </div>
        {onboardingSteps.length === 0 ? (
          <p className="mt-4 text-body-sm text-on-surface-variant">
            No onboarding rows yet. The tenant&apos;s steps are created lazily on first
            visit to the wizard.
          </p>
        ) : (
          <ul className="mt-4 space-y-2">
            {onboardingSteps.map((s) => (
              <li
                key={s.key}
                className="flex items-center justify-between gap-3 rounded-lg border border-outline-variant/30 bg-white/40 px-3 py-2"
              >
                <div>
                  <p className="text-body font-medium text-on-surface">{s.key}</p>
                  {s.completedAt && (
                    <p className="text-body-sm text-on-surface-variant">
                      Completed {new Date(s.completedAt).toLocaleString()}
                    </p>
                  )}
                </div>
                <span
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-body-sm font-medium ${STEP_STATUS_BADGE[s.status].cls}`}
                >
                  {STEP_STATUS_BADGE[s.status].label}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="glass rounded-xl p-6">
        <h3 className="text-h3 font-h3 text-on-surface">Recent activity</h3>
        <p className="mt-1 text-body-sm text-on-surface-variant">
          Last {recentActivity.length} audit rows for this tenant. Full log lives under
          Compliance → Audit log.
        </p>
        {recentActivity.length === 0 ? (
          <p className="mt-4 text-body-sm text-on-surface-variant">
            No audit rows recorded for this tenant yet.
          </p>
        ) : (
          <ul className="mt-4 space-y-1.5">
            {recentActivity.map((e) => (
              <ActivityRow key={e.id} entry={e} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}): JSX.Element {
  return (
    <div className="glass rounded-xl p-5">
      <p className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
        {label}
      </p>
      <p className="mt-2 text-h2 font-h2 text-on-surface">{value}</p>
      <p className="mt-1 text-body-sm text-on-surface-variant">{hint}</p>
    </div>
  );
}

function PrimaryAdminPanel({
  admin,
  onResend,
  resending,
}: {
  admin: TenantPrimaryAdminSummary | null;
  onResend: () => Promise<void>;
  resending: boolean;
}): JSX.Element {
  if (!admin) {
    return (
      <section className="glass rounded-xl p-6">
        <h3 className="text-h3 font-h3 text-on-surface">Primary admin</h3>
        <p className="mt-2 text-body-sm text-on-surface-variant">
          No tenant_admin user yet. This is a legacy seed tenant.
        </p>
      </section>
    );
  }
  const pending = admin.status === 'invited';
  return (
    <section className="glass rounded-xl p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-h3 font-h3 text-on-surface">Primary admin</h3>
          <p className="mt-2 text-body font-medium text-on-surface">
            {admin.firstName} {admin.lastName}
          </p>
          <p className="font-mono text-body-sm text-on-surface-variant">{admin.email}</p>
          <div className="mt-2 flex items-center gap-2">
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-body-sm font-medium ${
                pending
                  ? admin.inviteExpired
                    ? 'border-red-100 bg-red-50 text-red-700'
                    : 'border-amber-100 bg-amber-50 text-amber-700'
                  : 'border-green-100 bg-green-50 text-green-700'
              }`}
            >
              {pending
                ? admin.inviteExpired
                  ? 'Invite expired'
                  : 'Awaiting acceptance'
                : admin.status === 'active'
                  ? 'Active'
                  : admin.status}
            </span>
            {pending && admin.inviteExpiresAt && !admin.inviteExpired && (
              <span className="text-body-sm text-on-surface-variant">
                expires {new Date(admin.inviteExpiresAt).toLocaleString()}
              </span>
            )}
          </div>
        </div>
        {pending && (
          <button
            type="button"
            onClick={onResend}
            disabled={resending}
            className="btn-outline inline-flex items-center"
            style={{ padding: '8px 16px', fontSize: '13px' }}
          >
            <span className="material-symbols-outlined text-[18px]">
              mark_email_unread
            </span>
            {resending ? 'Sending…' : 'Resend invite'}
          </button>
        )}
      </div>
    </section>
  );
}

function ActivityRow({ entry }: { entry: AuditLogEntry }): JSX.Element {
  return (
    <li className="flex items-start gap-3 rounded-lg border border-outline-variant/20 bg-white/40 px-3 py-2">
      <span className="material-symbols-outlined text-[18px] text-on-surface-variant">
        history
      </span>
      <div className="flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <p className="font-mono text-body-sm font-semibold text-on-surface">
            {entry.action}
          </p>
          <p className="text-body-sm text-on-surface-variant">
            on <span className="font-mono">{entry.resourceType}</span>
          </p>
        </div>
        <p className="mt-0.5 text-body-sm text-on-surface-variant">
          {new Date(entry.occurredAt).toLocaleString()}
          {entry.actorUserId ? ` · actor ${entry.actorUserId.slice(0, 8)}…` : ''}
        </p>
      </div>
    </li>
  );
}
