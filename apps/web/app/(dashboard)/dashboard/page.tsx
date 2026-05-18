'use client';

// Dashboard home — Stitch-canonical layout:
//   1. Optional alert banner (e.g. mustChangePassword)
//   2. Bento grid (4 cols on xl, 2 on md, 1 on mobile):
//      - Hero tile (2×2): welcome + tenant + Create new case CTA
//      - 4 stat tiles (1×1 each): Open breaches · Overdue · Active consents · Unbound access
//   3. Quick Actions row: New case · Open cases · Compliance · Settlement

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { useErrorModal } from '../../../components/modals/ErrorModal/ErrorModalProvider';
import { LoadingShimmer } from '../../../components/ui/LoadingShimmer';
import { AuthApi } from '../../../lib/api/auth.api';
import { ApiError } from '../../../lib/api/client';
import { ComplianceApi } from '../../../lib/api/compliance.api';
import { DashboardApi } from '../../../lib/api/dashboard.api';

export default function DashboardPage(): JSX.Element {
  const router = useRouter();
  const { showApiError } = useErrorModal();

  const me = useQuery({
    queryKey: ['me'],
    queryFn: ({ signal }) => AuthApi.me(signal),
  });

  const compliance = useQuery({
    queryKey: ['compliance-dashboard-summary'],
    queryFn: () => ComplianceApi.dashboard(),
    enabled: me.data !== undefined,
    retry: false,
  });

  const operational = useQuery({
    queryKey: ['operational-dashboard'],
    queryFn: () => DashboardApi.operational(),
    enabled: me.data !== undefined,
    retry: false,
  });

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.problem.status === 401) {
      router.replace('/login');
      return;
    }
    if (me.error) showApiError(me.error);
  }, [me.error, router, showApiError]);

  if (me.isLoading) {
    return <LoadingShimmer variant="page" label="Loading dashboard" />;
  }
  if (!me.data) return <></>;

  const summary = compliance.data;
  const overdueOpen = summary?.openBreaches.filter((b) => b.overdue).length ?? 0;
  const greeting = greetingForNow(new Date());

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6">
      {me.data.mustChangePassword ? (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-white/50 border-l-white border-t-white bg-secondary-fixed/50 p-4 shadow-sm backdrop-blur-[24px]">
          <div className="flex items-center gap-3 text-secondary">
            <span className="material-symbols-outlined">warning</span>
            <span className="text-body font-medium">
              You signed in with the temporary password — change it before continuing real work.
            </span>
          </div>
          <Link
            href="/me/change-password"
            className="rounded-full border-[1.5px] border-secondary bg-white/50 px-4 py-1.5 text-eyebrow uppercase tracking-eyebrow text-secondary backdrop-blur-sm transition-colors hover:bg-secondary/10"
          >
            Update now
          </Link>
        </div>
      ) : null}

      {/* Operational tile row — "what does my team need to work
          on today." Distinct from the compliance bento below
          which is for governance / DPDP audience. Loads
          independently and silently degrades to '—' if the
          /dashboard/operational call fails. */}
      <section>
        <h3 className="mb-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
          Today&apos;s work
        </h3>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <OperationalTile
            label="Open claims"
            value={operational.data?.openClaims.total}
            subtext={
              operational.data
                ? `${operational.data.openClaims.drafting} drafting · ${operational.data.openClaims.awaitingPayer} awaiting payer`
                : undefined
            }
            icon="folder_open"
            tone="success"
            href="/cases?status=open"
          />
          <OperationalTile
            label="SLA at risk"
            value={
              operational.data
                ? operational.data.slaAtRisk.breached + operational.data.slaAtRisk.expiringSoon
                : undefined
            }
            subtext={
              operational.data
                ? `${operational.data.slaAtRisk.breached} breached · ${operational.data.slaAtRisk.expiringSoon} expiring soon`
                : undefined
            }
            icon="timer"
            tone={
              (operational.data?.slaAtRisk.breached ?? 0) > 0
                ? 'danger'
                : (operational.data?.slaAtRisk.expiringSoon ?? 0) > 0
                  ? 'warning'
                  : 'neutral'
            }
            href={
              (operational.data?.slaAtRisk.breached ?? 0) > 0
                ? '/cases?status=open&sla=breached'
                : '/cases?status=open&sla=any'
            }
          />
          <OperationalTile
            label="Discharges due"
            value={operational.data?.dischargesDueToday}
            subtext="within today ± 1 day"
            icon="logout"
            tone={
              (operational.data?.dischargesDueToday ?? 0) > 0 ? 'success' : 'neutral'
            }
            href="/cases?status=open&dischargeDue=true"
          />
          <OperationalTile
            label="Pending appeals"
            value={operational.data?.pendingAppeals}
            subtext="active or submitted"
            icon="gavel"
            tone={
              (operational.data?.pendingAppeals ?? 0) > 0 ? 'warning' : 'neutral'
            }
            href="/cases?status=open&appeals=true"
          />
        </div>
      </section>

      {/* Bento grid */}
      <div className="grid auto-rows-min grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
        {/* Hero tile (2×2) */}
        <section className="relative col-span-1 row-span-2 overflow-hidden rounded-xl border border-white/20 bg-gradient-to-br from-primary to-primary-container p-8 text-on-primary shadow-[0_8px_30px_rgba(0,102,110,0.15)] md:col-span-2 xl:col-span-2 flex flex-col justify-between">
          {/* Ambient glass shapes */}
          <div
            aria-hidden
            className="pointer-events-none absolute -right-[10%] -top-[20%] h-[60%] w-[60%] rounded-full bg-white/5 blur-[40px]"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-[10%] -left-[10%] h-[40%] w-[40%] rounded-full bg-primary-fixed-dim/20 blur-[40px]"
          />

          <div className="relative">
            <span className="mb-2 block text-eyebrow uppercase tracking-eyebrow text-primary-fixed-dim">
              {greeting}
            </span>
            <h2 className="mb-4 text-h1-mobile font-h1 text-secondary-fixed md:text-h1">
              Welcome back, {me.data.firstName}
            </h2>
            <p className="max-w-md text-body text-primary-fixed-dim/90">
              {me.data.tenantDisplayName}. Drive eligibility, preauth, claim submission, and EOB
              settlement — all from one place.
            </p>
          </div>

          <div className="relative mt-8 flex flex-wrap items-center gap-3">
            <Link href="/cases/new" className="btn-cta" style={{ padding: '12px 24px' }}>
              <span
                className="material-symbols-outlined"
                style={{ fontSize: 18, fontVariationSettings: "'FILL' 1" }}
              >
                add
              </span>
              Create new case
            </Link>
            <Link
              href="/cases"
              className="inline-flex items-center gap-2 rounded-full border border-white/30 bg-white/10 px-5 py-2.5 text-body-sm font-semibold text-on-primary backdrop-blur-md transition-colors hover:bg-white/20"
            >
              Open cases
              <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
            </Link>
          </div>
        </section>

        {/* Stat tiles */}
        <StatTile
          label="Open breaches"
          value={summary?.breachCounts.detected ?? 0}
          tone={(summary?.breachCounts.detected ?? 0) > 0 ? 'danger' : 'neutral'}
          icon="gpp_bad"
          href="/admin/compliance"
        />
        <StatTile
          label="Overdue cases"
          value={overdueOpen}
          tone={overdueOpen > 0 ? 'warning' : 'neutral'}
          icon="schedule"
          href="/admin/compliance"
        />
        <StatTile
          label="Active consents"
          value={summary?.consentCounts.granted ?? 0}
          tone="success"
          icon="verified_user"
          href="/admin/consents"
        />
        <StatTile
          label="Unbound access (24h)"
          value={summary?.unboundAccessCountLast24h ?? 0}
          tone={(summary?.unboundAccessCountLast24h ?? 0) > 0 ? 'warning' : 'neutral'}
          icon="no_accounts"
          href="/admin/audit"
        />
      </div>

      {/* Quick actions */}
      <div>
        <h3 className="mb-4 mt-2 text-h3 font-h3 text-on-surface">Quick actions</h3>
        <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
          <QuickAction href="/cases/new" label="New case" icon="post_add" />
          <QuickAction href="/cases" label="Open cases" icon="folder_open" />
          <QuickAction href="/admin/compliance" label="Compliance" icon="policy" />
          <QuickAction href="/admin/remittance" label="Settlement" icon="account_balance" />
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Bento sub-components
// -----------------------------------------------------------------------------

type Tone = 'success' | 'warning' | 'danger' | 'neutral';

interface StatTileProps {
  label: string;
  value: number;
  tone: Tone;
  icon: string;
  href: string;
}

const TONE_LIVE: Record<Tone, { dot: string; text: string }> = {
  success: { dot: 'bg-primary', text: 'text-primary' },
  warning: { dot: 'bg-secondary', text: 'text-secondary' },
  danger:  { dot: 'bg-error', text: 'text-error' },
  neutral: { dot: 'bg-outline', text: 'text-outline' },
};

const TONE_ICON: Record<Tone, { bg: string; fg: string }> = {
  success: { bg: 'bg-primary-fixed-dim/30', fg: 'text-primary' },
  warning: { bg: 'bg-secondary-fixed/50', fg: 'text-secondary' },
  danger:  { bg: 'bg-error-container/50', fg: 'text-error' },
  neutral: { bg: 'bg-surface-variant/50', fg: 'text-outline' },
};

function StatTile({ label, value, tone, icon, href }: StatTileProps): JSX.Element {
  const live = TONE_LIVE[tone];
  const ic = TONE_ICON[tone];
  return (
    <Link href={href} className="group col-span-1">
      <div className="flex h-full flex-col rounded-xl border border-white/40 border-l-white border-t-white bg-white/70 p-6 shadow-[0_4px_20px_rgba(0,102,110,0.05)] backdrop-blur-[24px] transition-colors group-hover:bg-white/80">
        <div className="mb-4 flex items-start justify-between">
          <span
            className={`flex items-center gap-1 text-eyebrow uppercase tracking-eyebrow ${live.text}`}
          >
            <span className={`h-2 w-2 animate-pulse rounded-full ${live.dot}`} />
            Live
          </span>
          <div
            className={`flex h-8 w-8 items-center justify-center rounded-full border border-white/50 ${ic.bg} ${ic.fg} backdrop-blur-sm`}
          >
            <span className="material-symbols-outlined text-[18px]">{icon}</span>
          </div>
        </div>
        <h3 className="mb-1 text-body-sm text-on-surface-variant">{label}</h3>
        <div className="text-h2 font-h2 tabular-nums text-on-surface">
          {value.toString().padStart(2, '0')}
        </div>
      </div>
    </Link>
  );
}

// Operational tile — denser than StatTile because it carries
// sub-text. Used for "today's work" row above the compliance
// bento. Renders '—' when value is undefined (loading or error).
function OperationalTile({
  label,
  value,
  subtext,
  icon,
  tone,
  href,
}: {
  label: string;
  value: number | undefined;
  subtext?: string;
  icon: string;
  tone: Tone;
  href: string;
}): JSX.Element {
  const ic = TONE_ICON[tone];
  return (
    <Link href={href} className="group">
      <div className="flex h-full flex-col rounded-xl border border-white/40 border-l-white border-t-white bg-white/70 p-5 shadow-[0_4px_20px_rgba(0,102,110,0.05)] backdrop-blur-[24px] transition-all group-hover:-translate-y-0.5 group-hover:bg-white/80 group-hover:shadow-lg">
        <div className="mb-3 flex items-start justify-between">
          <h3 className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
            {label}
          </h3>
          <div
            className={`flex h-8 w-8 items-center justify-center rounded-full border border-white/50 ${ic.bg} ${ic.fg} backdrop-blur-sm`}
          >
            <span className="material-symbols-outlined text-[18px]">{icon}</span>
          </div>
        </div>
        <div className="text-h1-mobile font-h1 tabular-nums text-on-surface md:text-h1">
          {value === undefined ? '—' : value.toString()}
        </div>
        {subtext ? (
          <p className="mt-1 text-[12px] text-on-surface-variant">{subtext}</p>
        ) : null}
      </div>
    </Link>
  );
}

function QuickAction({
  href,
  label,
  icon,
}: {
  href: string;
  label: string;
  icon: string;
}): JSX.Element {
  return (
    <Link
      href={href}
      className="group flex items-center gap-4 rounded-xl border border-white/60 bg-primary-fixed/10 p-4 text-left backdrop-blur-[12px] transition-colors hover:bg-primary-fixed/25"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary transition-transform group-hover:scale-110">
        <span className="material-symbols-outlined">{icon}</span>
      </div>
      <span className="text-body font-medium text-on-surface">{label}</span>
    </Link>
  );
}

function greetingForNow(d: Date): string {
  const h = d.getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}
