'use client';

// Dashboard home — operations command centre.
//
// The intent is "open the app and instantly see what to act on next."
// Layout (top → bottom):
//   1. Alert ribbon       — only renders when there's a hard red item
//                           (overdue breach notification or SLA-breached
//                           cases). Skipped otherwise.
//   2. Welcome hero + KPIs — greeting tile + 4 operational counts.
//   3. What needs attention — 2×2 grid of live case rows pulled from
//                            /cases with the filters that match each
//                            warning bucket. Patient + MRN + time-pill +
//                            link, not just a count.
//   4. Compliance pulse    — open breaches (with overdue flagging),
//                           unbound access count, recent consent changes.
//   5. Quick actions       — slimmed legacy row, kept as muscle-memory
//                            shortcuts.

import {
  type CaseSummary,
  type SlaState,
} from '@claims/contracts';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { useErrorModal } from '../../../components/modals/ErrorModal/ErrorModalProvider';
import { LoadingShimmer } from '../../../components/ui/LoadingShimmer';
import { AuthApi } from '../../../lib/api/auth.api';
import { CaseApi } from '../../../lib/api/case.api';
import { ApiError } from '../../../lib/api/client';
import { ComplianceApi } from '../../../lib/api/compliance.api';
import { DashboardApi } from '../../../lib/api/dashboard.api';

const ATTENTION_LIMIT = 5;

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

  // Actionable case lists — each filter mirrors a warning bucket
  // surfaced higher up the page. Limit=5 so the dashboard stays
  // skim-able; "View all" link drops the operator into /cases with
  // the same filter pre-applied.
  const slaBreached = useQuery({
    queryKey: ['dashboard-cases-sla-breached'],
    queryFn: () =>
      CaseApi.list({ status: 'open', sla: 'breached', limit: ATTENTION_LIMIT }),
    enabled: me.data !== undefined,
    retry: false,
  });

  const slaAtRisk = useQuery({
    queryKey: ['dashboard-cases-sla-at-risk'],
    queryFn: () =>
      CaseApi.list({ status: 'open', sla: 'at_risk', limit: ATTENTION_LIMIT }),
    enabled: me.data !== undefined,
    retry: false,
  });

  const dischargesDue = useQuery({
    queryKey: ['dashboard-cases-discharges-due'],
    queryFn: () =>
      CaseApi.list({
        status: 'open',
        dischargeDue: true,
        limit: ATTENTION_LIMIT,
      }),
    enabled: me.data !== undefined,
    retry: false,
  });

  const appeals = useQuery({
    queryKey: ['dashboard-cases-appeals'],
    queryFn: () =>
      CaseApi.list({ status: 'open', appeals: true, limit: ATTENTION_LIMIT }),
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
  const overdueBreaches =
    summary?.openBreaches.filter((b) => b.overdue).length ?? 0;
  const breachedSlaCount = operational.data?.slaAtRisk.breached ?? 0;
  const greeting = greetingForNow(new Date());

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6">
      {/* Forced password change banner — preserved from the previous
          layout. Renders above the alert ribbon since it blocks the
          rest of the user's session. */}
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

      <AlertRibbon
        breachedSla={breachedSlaCount}
        overdueBreaches={overdueBreaches}
      />

      {/* Hero + KPI strip — 60/40 split on xl. Hero stays visually
          dominant (it carries the create-case CTA) but the KPIs sit
          next to it instead of below so the actionable lists below
          aren't pushed under the fold. */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
        <HeroTile
          greeting={greeting}
          firstName={me.data.firstName}
          tenantDisplayName={me.data.tenantDisplayName}
        />
        <div className="grid grid-cols-2 gap-4 xl:col-span-2 xl:grid-cols-2">
          <KpiTile
            label="Open claims"
            value={operational.data?.openClaims.total}
            subtext={
              operational.data
                ? `${operational.data.openClaims.drafting} drafting · ${operational.data.openClaims.awaitingPayer} with payer`
                : undefined
            }
            icon="folder_open"
            tone="success"
            href="/cases?status=open"
          />
          <KpiTile
            label="Insurer chase"
            value={
              operational.data
                ? operational.data.slaAtRisk.breached +
                  operational.data.slaAtRisk.expiringSoon
                : undefined
            }
            subtext={
              operational.data
                ? `${operational.data.slaAtRisk.breached} reply overdue · ${operational.data.slaAtRisk.expiringSoon} running late`
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
          <KpiTile
            label="Discharges today"
            value={operational.data?.dischargesDueToday}
            subtext="within today ± 1 day"
            icon="logout"
            tone={
              (operational.data?.dischargesDueToday ?? 0) > 0
                ? 'success'
                : 'neutral'
            }
            href="/cases?status=open&dischargeDue=true"
          />
          <KpiTile
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
      </div>

      {/* What needs attention — actionable case rows pulled live from
          /cases. Each panel is independent so a slow filter doesn't
          block the others, and each shows up to ATTENTION_LIMIT
          rows with a "View all" link to the matching /cases filter. */}
      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-h3 font-h3 text-on-surface">
            What needs your attention
          </h3>
          <span className="text-body-sm text-on-surface-variant">
            Live case rows · click any to open
          </span>
        </div>
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <AttentionPanel
            title="Chase the insurer"
            icon="timer"
            tone={
              (slaBreached.data?.cases.length ?? 0) > 0 ? 'danger' : 'warning'
            }
            emptyLabel="All insurer replies are on time."
            viewAllHref="/cases?status=open&sla=any"
            isLoading={slaBreached.isLoading || slaAtRisk.isLoading}
            cases={mergeInsurerChase(
              slaBreached.data?.cases ?? [],
              slaAtRisk.data?.cases ?? [],
            )}
            renderTrailing={renderSlaPill}
          />
          <AttentionPanel
            title="Discharges due today"
            icon="logout"
            tone="success"
            emptyLabel="No discharges scheduled for today."
            viewAllHref="/cases?status=open&dischargeDue=true"
            isLoading={dischargesDue.isLoading}
            cases={dischargesDue.data?.cases ?? []}
            renderTrailing={renderAdmissionDay}
          />
          <AttentionPanel
            title="Pending appeals"
            icon="gavel"
            tone="warning"
            emptyLabel="No appeals are awaiting your action."
            viewAllHref="/cases?status=open&appeals=true"
            isLoading={appeals.isLoading}
            cases={appeals.data?.cases ?? []}
            renderTrailing={renderRailBadge}
          />
        </div>
      </section>

      {/* Compliance pulse — DPDP / IRDAI / RBI signal at a glance.
          Three columns: open breaches list (with overdue red), counts
          rollup (consents + unbound access), and recent consent
          changes. Each panel links into the deep-dive page so DPOs
          can drill in. */}
      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-h3 font-h3 text-on-surface">Compliance pulse</h3>
          <Link
            href="/admin/compliance"
            className="text-body-sm font-semibold text-primary hover:underline"
          >
            Open full dashboard →
          </Link>
        </div>
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <CompliancePanel
            title="Open breaches"
            icon="gpp_bad"
            tone={overdueBreaches > 0 ? 'danger' : 'warning'}
            emptyLabel="No open breaches. ✓"
            viewAllHref="/admin/compliance"
            isLoading={compliance.isLoading}
          >
            {summary && summary.openBreaches.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {summary.openBreaches.slice(0, 4).map((b) => (
                  <li
                    key={b.id}
                    className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${
                      b.overdue
                        ? 'border-error/40 bg-error-container/40'
                        : 'border-outline-variant/40 bg-surface-container-lowest/50'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-body-sm font-medium text-on-surface">
                        {prettifyBreachKind(b.kind)}
                      </div>
                      <div className="truncate text-[12px] text-on-surface-variant">
                        Severity {b.severity} · {b.affectedDataPrincipals} data principals
                      </div>
                    </div>
                    {b.overdue ? (
                      <span className="rounded-full bg-error/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-eyebrow text-error">
                        DPDP overdue
                      </span>
                    ) : (
                      <span className="rounded-full bg-secondary/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-eyebrow text-secondary">
                        notify in {timeUntil(b.dpdpNotificationDueAt)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon="verified_user" label="No open breaches. ✓" />
            )}
          </CompliancePanel>

          <CompliancePanel
            title="Consents & access"
            icon="verified_user"
            tone={
              (summary?.unboundAccessCountLast24h ?? 0) > 0 ? 'warning' : 'success'
            }
            viewAllHref="/admin/consents"
            isLoading={compliance.isLoading}
          >
            <div className="grid grid-cols-2 gap-3">
              <MiniStat
                label="Active consents"
                value={summary?.consentCounts.granted ?? 0}
                tone="success"
              />
              <MiniStat
                label="Withdrawn"
                value={summary?.consentCounts.withdrawn ?? 0}
                tone="neutral"
              />
              <MiniStat
                label="Expired"
                value={summary?.consentCounts.expired ?? 0}
                tone="warning"
              />
              <MiniStat
                label="Unbound access (24h)"
                value={summary?.unboundAccessCountLast24h ?? 0}
                tone={
                  (summary?.unboundAccessCountLast24h ?? 0) > 0
                    ? 'warning'
                    : 'neutral'
                }
                href="/admin/audit"
              />
            </div>
          </CompliancePanel>

          <CompliancePanel
            title="Recent consent changes"
            icon="history"
            tone="neutral"
            viewAllHref="/admin/consents"
            isLoading={compliance.isLoading}
          >
            {summary && summary.recentConsentChanges.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {summary.recentConsentChanges.slice(0, 4).map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-outline-variant/40 bg-surface-container-lowest/50 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-body-sm font-medium text-on-surface">
                        {prettifyConsentType(c.consentType)}
                      </div>
                      <div className="text-[12px] text-on-surface-variant">
                        {relativeTime(c.withdrawnAt ?? c.grantedAt)}
                      </div>
                    </div>
                    <ConsentStatusBadge status={c.status} />
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon="check_circle" label="No recent changes." />
            )}
          </CompliancePanel>
        </div>
      </section>

      {/* Quick actions — kept as muscle-memory shortcuts. Compressed
          to a single row of icons so it doesn't compete with the
          actionable lists above for attention. */}
      <section>
        <h3 className="mb-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
          Quick actions
        </h3>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <QuickAction href="/cases/new" label="New case" icon="post_add" />
          <QuickAction href="/cases" label="Open cases" icon="folder_open" />
          <QuickAction
            href="/admin/remittance"
            label="Settlement"
            icon="account_balance"
          />
          <QuickAction
            href="/admin/audit"
            label="Audit log"
            icon="manage_search"
          />
        </div>
      </section>
    </div>
  );
}

// =============================================================================
// Alert ribbon — only renders when there's a hard red item
// =============================================================================

function AlertRibbon({
  breachedSla,
  overdueBreaches,
}: {
  breachedSla: number;
  overdueBreaches: number;
}): JSX.Element | null {
  if (breachedSla === 0 && overdueBreaches === 0) return null;
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-error/30 bg-error-container/40 p-4 shadow-sm backdrop-blur-[14px] md:flex-row md:items-center md:justify-between">
      <div className="flex items-start gap-3 text-on-surface">
        <span className="material-symbols-outlined mt-0.5 text-error">
          priority_high
        </span>
        <div className="text-body-sm">
          <p className="font-semibold text-on-surface">Action required now</p>
          <ul className="mt-1 list-inside list-disc text-on-surface-variant">
            {breachedSla > 0 ? (
              <li>
                {breachedSla} claim{breachedSla === 1 ? '' : 's'} where the
                insurer&apos;s reply is overdue — chase the insurer now.
              </li>
            ) : null}
            {overdueBreaches > 0 ? (
              <li>
                {overdueBreaches} data breach
                {overdueBreaches === 1 ? '' : 'es'} not yet reported to the
                regulator within the 72-hour window.
              </li>
            ) : null}
          </ul>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {breachedSla > 0 ? (
          <Link
            href="/cases?status=open&sla=breached"
            className="rounded-full border border-error/50 bg-white/60 px-4 py-1.5 text-eyebrow uppercase tracking-eyebrow text-error backdrop-blur-sm transition-colors hover:bg-error/10"
          >
            Chase the insurer
          </Link>
        ) : null}
        {overdueBreaches > 0 ? (
          <Link
            href="/admin/compliance"
            className="rounded-full border border-error/50 bg-white/60 px-4 py-1.5 text-eyebrow uppercase tracking-eyebrow text-error backdrop-blur-sm transition-colors hover:bg-error/10"
          >
            Notify regulator
          </Link>
        ) : null}
      </div>
    </div>
  );
}

// =============================================================================
// Hero + KPI tiles
// =============================================================================

function HeroTile({
  greeting,
  firstName,
  tenantDisplayName,
}: {
  greeting: string;
  firstName: string;
  tenantDisplayName: string;
}): JSX.Element {
  return (
    <section className="relative col-span-1 row-span-1 overflow-hidden rounded-xl border border-white/20 bg-gradient-to-br from-primary to-primary-container p-7 text-on-primary shadow-[0_8px_30px_rgba(0,102,110,0.15)] xl:col-span-3 flex flex-col justify-between min-h-[200px]">
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
        <h2 className="mb-2 text-h2 font-h1 text-secondary-fixed">
          Welcome back, {firstName}
        </h2>
        <p className="max-w-md text-body-sm text-primary-fixed-dim/90">
          {tenantDisplayName}
        </p>
      </div>

      <div className="relative mt-6 flex flex-wrap items-center gap-3">
        <Link href="/cases/new" className="btn-cta" style={{ padding: '12px 24px' }}>
          <span
            className="material-symbols-outlined"
            style={{ fontSize: 18, fontVariationSettings: "'FILL' 1" }}
          >
            add
          </span>
          New case
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
  );
}

type Tone = 'success' | 'warning' | 'danger' | 'neutral';

const TONE_ICON: Record<Tone, { bg: string; fg: string }> = {
  success: { bg: 'bg-primary-fixed-dim/30', fg: 'text-primary' },
  warning: { bg: 'bg-secondary-fixed/50', fg: 'text-secondary' },
  danger: { bg: 'bg-error-container/50', fg: 'text-error' },
  neutral: { bg: 'bg-surface-variant/50', fg: 'text-outline' },
};

function KpiTile({
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
      <div className="flex h-full flex-col rounded-xl border border-white/40 border-l-white border-t-white bg-white/70 p-4 shadow-[0_4px_20px_rgba(0,102,110,0.05)] backdrop-blur-[24px] transition-all group-hover:-translate-y-0.5 group-hover:bg-white/80 group-hover:shadow-lg">
        <div className="mb-2 flex items-start justify-between">
          <h3 className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
            {label}
          </h3>
          <div
            className={`flex h-7 w-7 items-center justify-center rounded-full border border-white/50 ${ic.bg} ${ic.fg} backdrop-blur-sm`}
          >
            <span className="material-symbols-outlined text-[16px]">{icon}</span>
          </div>
        </div>
        <div className="text-h2 font-h2 tabular-nums text-on-surface">
          {value === undefined ? '—' : value.toString()}
        </div>
        {subtext ? (
          <p className="mt-1 text-[11px] text-on-surface-variant">{subtext}</p>
        ) : null}
      </div>
    </Link>
  );
}

// =============================================================================
// Attention panel — actionable case rows
// =============================================================================

function AttentionPanel({
  title,
  icon,
  tone,
  emptyLabel,
  viewAllHref,
  isLoading,
  cases,
  renderTrailing,
}: {
  title: string;
  icon: string;
  tone: Tone;
  emptyLabel: string;
  viewAllHref: string;
  isLoading: boolean;
  cases: CaseSummary[];
  renderTrailing: (c: CaseSummary) => JSX.Element;
}): JSX.Element {
  const ic = TONE_ICON[tone];
  return (
    <div className="glass flex flex-col rounded-xl p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div
            className={`flex h-7 w-7 items-center justify-center rounded-full border border-white/50 ${ic.bg} ${ic.fg} backdrop-blur-sm`}
          >
            <span className="material-symbols-outlined text-[16px]">{icon}</span>
          </div>
          <h4 className="text-body font-semibold text-on-surface">{title}</h4>
          {!isLoading && cases.length > 0 ? (
            <span className="rounded-full bg-on-surface/5 px-2 py-0.5 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
              {cases.length}
            </span>
          ) : null}
        </div>
        <Link
          href={viewAllHref}
          className="text-body-sm font-semibold text-primary hover:underline"
        >
          View all →
        </Link>
      </div>

      {isLoading ? (
        <PanelSkeleton />
      ) : cases.length === 0 ? (
        <EmptyState icon="check_circle" label={emptyLabel} />
      ) : (
        <ul className="flex flex-col gap-2">
          {cases.map((c) => (
            <li key={c.id}>
              <Link
                href={`/cases/${c.id}`}
                className="group flex items-center justify-between gap-3 rounded-lg border border-outline-variant/40 bg-surface-container-lowest/50 px-3 py-2 transition-colors hover:border-primary/40 hover:bg-primary-fixed/10"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body-sm font-medium text-on-surface">
                    {c.patientName}
                  </div>
                  <div className="truncate text-[12px] text-on-surface-variant">
                    MRN {c.hospitalMrn} ·{' '}
                    {prettifyClaimStatus(c.headlineClaimStatus)}
                  </div>
                </div>
                {renderTrailing(c)}
                <span className="material-symbols-outlined text-[18px] text-on-surface-variant transition-transform group-hover:translate-x-0.5">
                  chevron_right
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function renderSlaPill(c: CaseSummary): JSX.Element {
  const active = pickActiveSla(c.sla?.preauth ?? null, c.sla?.claim ?? null);
  if (!active) {
    return (
      <span className="rounded-full bg-on-surface/5 px-2 py-0.5 text-[11px] uppercase tracking-eyebrow text-on-surface-variant">
        no SLA
      </span>
    );
  }
  const tone: Tone =
    active.status === 'breached' || active.status === 'missed'
      ? 'danger'
      : active.status === 'at_risk'
        ? 'warning'
        : 'success';
  const label =
    active.msUntilDeadline === null
      ? active.status
      : active.msUntilDeadline < 0
        ? `${formatDuration(-active.msUntilDeadline)} late`
        : `${formatDuration(active.msUntilDeadline)} left`;
  const cls =
    tone === 'danger'
      ? 'bg-error/10 text-error'
      : tone === 'warning'
        ? 'bg-secondary/15 text-secondary'
        : 'bg-primary/10 text-primary';
  return (
    <span
      className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-eyebrow ${cls}`}
    >
      {active.phase} · {label}
    </span>
  );
}

function renderAdmissionDay(c: CaseSummary): JSX.Element {
  return (
    <span className="whitespace-nowrap rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-eyebrow text-primary">
      adm {formatDate(c.admissionDate)}
    </span>
  );
}

function renderRailBadge(c: CaseSummary): JSX.Element {
  const cls =
    c.primaryRail === 'pmjay'
      ? 'bg-secondary/15 text-secondary'
      : c.primaryRail === 'nhcx'
        ? 'bg-primary/10 text-primary'
        : 'bg-on-surface/5 text-on-surface-variant';
  return (
    <span
      className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-eyebrow ${cls}`}
    >
      {c.primaryRail}
    </span>
  );
}

// Merge the breached and at-risk lists into one ordered chase list:
// breached first (insurer's reply window has lapsed) then at-risk
// (≥50% of the window elapsed, no reply yet). De-duped by case id in
// case the two queries race and a row flips between buckets mid-fetch.
function mergeInsurerChase(
  breached: CaseSummary[],
  atRisk: CaseSummary[],
): CaseSummary[] {
  const seen = new Set<string>();
  const out: CaseSummary[] = [];
  for (const c of [...breached, ...atRisk]) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
    if (out.length >= ATTENTION_LIMIT) break;
  }
  return out;
}

function pickActiveSla(
  preauth: SlaState | null,
  claim: SlaState | null,
): SlaState | null {
  // Prefer the SLA whose deadline is closest (or most-overdue). When
  // both exist, pick the one that's not yet settled.
  const candidates = [preauth, claim].filter(
    (s): s is SlaState =>
      s !== null &&
      (s.status === 'breached' || s.status === 'at_risk' || s.status === 'on_track'),
  );
  if (candidates.length === 0) return preauth ?? claim;
  const sorted = [...candidates].sort((a, b) => {
    const aMs = a.msUntilDeadline ?? 0;
    const bMs = b.msUntilDeadline ?? 0;
    return aMs - bMs;
  });
  return sorted[0] ?? null;
}

// =============================================================================
// Compliance panel
// =============================================================================

function CompliancePanel({
  title,
  icon,
  tone,
  emptyLabel: _emptyLabel,
  viewAllHref,
  isLoading,
  children,
}: {
  title: string;
  icon: string;
  tone: Tone;
  emptyLabel?: string;
  viewAllHref: string;
  isLoading: boolean;
  children: React.ReactNode;
}): JSX.Element {
  const ic = TONE_ICON[tone];
  return (
    <div className="glass flex flex-col rounded-xl p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div
            className={`flex h-7 w-7 items-center justify-center rounded-full border border-white/50 ${ic.bg} ${ic.fg} backdrop-blur-sm`}
          >
            <span className="material-symbols-outlined text-[16px]">{icon}</span>
          </div>
          <h4 className="text-body font-semibold text-on-surface">{title}</h4>
        </div>
        <Link
          href={viewAllHref}
          className="text-body-sm font-semibold text-primary hover:underline"
        >
          Details →
        </Link>
      </div>
      {isLoading ? <PanelSkeleton /> : children}
    </div>
  );
}

function MiniStat({
  label,
  value,
  tone,
  href,
}: {
  label: string;
  value: number;
  tone: Tone;
  href?: string;
}): JSX.Element {
  const colorCls =
    tone === 'danger'
      ? 'text-error'
      : tone === 'warning'
        ? 'text-secondary'
        : tone === 'success'
          ? 'text-primary'
          : 'text-on-surface';
  const inner = (
    <div className="flex flex-col rounded-lg border border-outline-variant/40 bg-surface-container-lowest/50 px-3 py-2">
      <span className="text-[11px] uppercase tracking-eyebrow text-on-surface-variant">
        {label}
      </span>
      <span className={`text-h3 font-semibold tabular-nums ${colorCls}`}>
        {value.toString()}
      </span>
    </div>
  );
  if (href) {
    return (
      <Link href={href} className="block transition-transform hover:-translate-y-px">
        {inner}
      </Link>
    );
  }
  return inner;
}

function ConsentStatusBadge({
  status,
}: {
  status: 'granted' | 'withdrawn' | 'expired' | 'superseded' | 'pending_countersign';
}): JSX.Element {
  const cls =
    status === 'granted'
      ? 'bg-primary/10 text-primary'
      : status === 'expired'
        ? 'bg-secondary/15 text-secondary'
        : status === 'pending_countersign'
          ? 'bg-blue-50 text-blue-700'
          : 'bg-on-surface/5 text-on-surface-variant';
  return (
    <span
      className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-eyebrow ${cls}`}
    >
      {status.replaceAll('_', ' ')}
    </span>
  );
}

// =============================================================================
// Shared bits
// =============================================================================

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

function EmptyState({
  icon,
  label,
}: {
  icon: string;
  label: string;
}): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-outline-variant/40 bg-surface-container-lowest/30 px-3 py-6 text-center">
      <span className="material-symbols-outlined text-[28px] text-primary">
        {icon}
      </span>
      <p className="mt-1 text-body-sm text-on-surface-variant">{label}</p>
    </div>
  );
}

function PanelSkeleton(): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-10 animate-pulse rounded-lg bg-on-surface/5"
        />
      ))}
    </div>
  );
}

// =============================================================================
// Formatting helpers
// =============================================================================

function greetingForNow(d: Date): string {
  const h = d.getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function prettifyClaimStatus(status: string | null): string {
  if (!status) return 'no claim yet';
  return status.replaceAll('_', ' ').toLowerCase();
}

function prettifyBreachKind(kind: string): string {
  return kind.replaceAll('_', ' ');
}

function prettifyConsentType(type: string): string {
  return type.replaceAll('_', ' ');
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function timeUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'now';
  return formatDuration(ms);
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  if (ms < 60_000) return 'just now';
  return `${formatDuration(ms)} ago`;
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}
