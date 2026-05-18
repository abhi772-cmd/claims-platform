'use client';

import { type CaseSummary } from '@claims/contracts';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useErrorModal } from '../../../components/modals/ErrorModal/ErrorModalProvider';
import { SlaPill } from '../../../components/sla/SlaPill';
import { LoadingShimmer } from '../../../components/ui/LoadingShimmer';
import { AuthApi } from '../../../lib/api/auth.api';
import { CaseApi } from '../../../lib/api/case.api';

// Case-status filter (broadest axis — open/closed/abandoned).
type StatusFilter = 'all' | 'open' | 'closed' | 'abandoned';
const STATUS_LABEL: Record<StatusFilter, string> = {
  all: 'All',
  open: 'Open',
  closed: 'Closed',
  abandoned: 'Abandoned',
};
const STATUS_FILTERS: StatusFilter[] = ['all', 'open', 'closed', 'abandoned'];

// Claim-phase filter (orthogonal to case status; matches the
// dashboard tile bucketing one-to-one).
type PhaseFilter = 'all' | 'drafting' | 'awaitingPayer' | 'approved' | 'paymentPending';
const PHASE_LABEL: Record<PhaseFilter, string> = {
  all: 'Any phase',
  drafting: 'Drafting',
  awaitingPayer: 'Awaiting payer',
  approved: 'Approved',
  paymentPending: 'Payment pending',
};
const PHASE_FILTERS: PhaseFilter[] = [
  'all',
  'drafting',
  'awaitingPayer',
  'approved',
  'paymentPending',
];

// SLA quick filter — matches the dashboard "SLA at risk" tile.
type SlaFilter = 'all' | 'any' | 'breached' | 'at_risk';
const SLA_LABEL: Record<SlaFilter, string> = {
  all: 'All',
  any: 'At risk + breached',
  breached: 'Breached',
  at_risk: 'At risk',
};

function isStatusFilter(v: string | null): v is StatusFilter {
  return v === 'all' || v === 'open' || v === 'closed' || v === 'abandoned';
}
function isPhaseFilter(v: string | null): v is PhaseFilter {
  return (
    v === 'all' ||
    v === 'drafting' ||
    v === 'awaitingPayer' ||
    v === 'approved' ||
    v === 'paymentPending'
  );
}
function isSlaFilter(v: string | null): v is SlaFilter {
  return v === 'all' || v === 'any' || v === 'breached' || v === 'at_risk';
}

export default function CasesListPage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const router = useRouter();
  const searchParams = useSearchParams();

  // Initial state hydrates from URL params so deep-links from the
  // dashboard tiles (/cases?phase=drafting, /cases?sla=any, etc.)
  // land on the right view without an extra render.
  const [status, setStatus] = useState<StatusFilter>(() => {
    const s = searchParams.get('status');
    return isStatusFilter(s) ? s : 'open';
  });
  const [phase, setPhase] = useState<PhaseFilter>(() => {
    const p = searchParams.get('phase');
    return isPhaseFilter(p) ? p : 'all';
  });
  const [sla, setSla] = useState<SlaFilter>(() => {
    const v = searchParams.get('sla');
    return isSlaFilter(v) ? v : 'all';
  });
  const [appeals, setAppeals] = useState<boolean>(
    searchParams.get('appeals') === 'true',
  );
  const [dischargeDue, setDischargeDue] = useState<boolean>(
    searchParams.get('dischargeDue') === 'true',
  );
  const [mine, setMine] = useState<boolean>(searchParams.get('mine') === 'true');
  // Current operator's userId, used when `mine` is on. Fetched
  // once on mount; cached for the page's lifetime. Falls back to
  // null if /me fails (the filter then silently does nothing).
  const [myUserId, setMyUserId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    AuthApi.me()
      .then((me) => {
        if (!cancelled) setMyUserId(me.id);
      })
      .catch(() => {
        // ignore — filter chip stays inert
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // Search input — held separately from `debouncedQ` so typing
  // doesn't fire a request on every keystroke.
  const [searchInput, setSearchInput] = useState<string>(searchParams.get('q') ?? '');
  const [debouncedQ, setDebouncedQ] = useState<string>(searchInput);

  // 300 ms debounce on the search input so the cases call fires
  // once after the operator stops typing.
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedQ(searchInput), 300);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  // Push the current filter state back into the URL so links are
  // bookmarkable AND browser back/forward works. Replace not push
  // so the operator's history isn't polluted by every chip click.
  useEffect(() => {
    const qs = new URLSearchParams();
    if (status !== 'open') qs.set('status', status);
    if (phase !== 'all') qs.set('phase', phase);
    if (sla !== 'all') qs.set('sla', sla);
    if (appeals) qs.set('appeals', 'true');
    if (dischargeDue) qs.set('dischargeDue', 'true');
    if (mine) qs.set('mine', 'true');
    if (debouncedQ.trim().length > 0) qs.set('q', debouncedQ.trim());
    const next = qs.toString();
    const current = window.location.search.replace(/^\?/, '');
    if (next !== current) {
      router.replace(`/cases${next ? `?${next}` : ''}`, { scroll: false });
    }
  }, [status, phase, sla, appeals, dischargeDue, mine, debouncedQ, router]);

  const [cases, setCases] = useState<CaseSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCases(null);
    CaseApi.list({
      ...(status !== 'all' ? { status } : {}),
      ...(phase !== 'all' ? { phase } : {}),
      ...(sla !== 'all' ? { sla } : {}),
      ...(appeals ? { appeals: true } : {}),
      ...(dischargeDue ? { dischargeDue: true } : {}),
      ...(mine && myUserId ? { assignedTo: myUserId } : {}),
      ...(debouncedQ.trim().length > 0 ? { q: debouncedQ.trim() } : {}),
    })
      .then((r) => {
        if (!cancelled) setCases(r.cases);
      })
      .catch((err: unknown) => {
        if (!cancelled) showApiError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [status, phase, sla, appeals, dischargeDue, mine, myUserId, debouncedQ, showApiError]);

  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (status !== 'open') n += 1;
    if (phase !== 'all') n += 1;
    if (sla !== 'all') n += 1;
    if (appeals) n += 1;
    if (dischargeDue) n += 1;
    if (mine) n += 1;
    if (debouncedQ.trim().length > 0) n += 1;
    return n;
  }, [status, phase, sla, appeals, dischargeDue, mine, debouncedQ]);

  const clearAll = useCallback(() => {
    setStatus('open');
    setPhase('all');
    setSla('all');
    setAppeals(false);
    setDischargeDue(false);
    setMine(false);
    setSearchInput('');
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6">
      {/* Header card */}
      <div className="glass flex flex-col items-start justify-between gap-4 rounded-xl p-6 shadow-[0_4px_24px_rgba(0,102,110,0.05)] md:flex-row md:items-center">
        <div>
          <h2 className="text-h1 font-h1 text-on-surface">Cases</h2>
          <p className="mt-1 text-body text-on-surface-variant">
            Manage and track all patient claims and pre-authorizations.
          </p>
        </div>
        <Link href="/cases/new" className="btn-cta" style={{ padding: '10px 24px' }}>
          <span
            className="material-symbols-outlined"
            style={{ fontSize: 20, fontVariationSettings: "'FILL' 1" }}
          >
            add
          </span>
          New case
        </Link>
      </div>

      {/* Search + filter rail */}
      <section className="glass space-y-4 rounded-xl p-4 shadow-[0_2px_12px_rgba(0,102,110,0.03)]">
        {/* Search row */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="relative flex-1 min-w-[260px] max-w-2xl">
            <span
              aria-hidden
              className="material-symbols-outlined pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[20px] text-on-surface-variant"
            >
              search
            </span>
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search patient name, MRN, preauth or claim ref…"
              className="glass-input glass-input--sm w-full pl-10"
              aria-label="Search cases"
            />
            {searchInput.length > 0 && searchInput !== debouncedQ ? (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-on-surface-variant">
                searching…
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-3 text-body-sm text-on-surface-variant">
            <span>
              {cases === null
                ? 'loading…'
                : `${cases.length} ${cases.length === 1 ? 'case' : 'cases'}`}
            </span>
            {activeFilterCount > 0 ? (
              <button
                type="button"
                onClick={clearAll}
                className="text-[12px] text-primary hover:underline"
                title="Reset all filters"
              >
                Clear all ({activeFilterCount})
              </button>
            ) : null}
          </div>
        </div>

        {/* Status row — broadest axis, top-of-mind */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
            Status
          </span>
          {STATUS_FILTERS.map((s) => {
            const active = status === s;
            return (
              <FilterChip
                key={s}
                label={STATUS_LABEL[s]}
                active={active}
                onClick={() => setStatus(s)}
              />
            );
          })}
        </div>

        {/* Claim-phase row — same buckets as dashboard tiles */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
            Phase
          </span>
          {PHASE_FILTERS.map((p) => {
            const active = phase === p;
            return (
              <FilterChip
                key={p}
                label={PHASE_LABEL[p]}
                active={active}
                onClick={() => setPhase(p)}
              />
            );
          })}
        </div>

        {/* Quick filters — SLA + appeals + discharge-due, the
            dashboard-tile deep-link targets */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
            Quick
          </span>
          <FilterChip
            icon="timer"
            label={`SLA: ${SLA_LABEL[sla]}`}
            active={sla !== 'all'}
            tone="warning"
            onClick={() => {
              // Cycle through: all → any → breached → at_risk → all
              setSla((cur) =>
                cur === 'all'
                  ? 'any'
                  : cur === 'any'
                    ? 'breached'
                    : cur === 'breached'
                      ? 'at_risk'
                      : 'all',
              );
            }}
          />
          <FilterChip
            icon="logout"
            label="Discharges due"
            active={dischargeDue}
            onClick={() => setDischargeDue((v) => !v)}
          />
          <FilterChip
            icon="gavel"
            label="In appeal"
            active={appeals}
            tone="warning"
            onClick={() => setAppeals((v) => !v)}
          />
          <FilterChip
            icon="person"
            label="Mine"
            active={mine}
            onClick={() => setMine((v) => !v)}
          />
        </div>
      </section>

      {/* Body */}
      {cases === null ? (
        <LoadingShimmer variant="row" rows={6} label="Loading cases" />
      ) : cases.length === 0 ? (
        <EmptyState activeFilters={activeFilterCount} onClearAll={clearAll} />
      ) : (
        <div className="glass flex flex-1 flex-col overflow-hidden rounded-xl shadow-[0_8px_32px_rgba(0,102,110,0.05)]">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-surface-variant/50 bg-white/30">
                  <th className="px-6 py-4 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                    Patient
                  </th>
                  <th className="px-6 py-4 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                    MRN
                  </th>
                  <th className="px-6 py-4 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                    Admission
                  </th>
                  <th className="px-6 py-4 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                    Rail
                  </th>
                  <th className="px-6 py-4 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                    Status
                  </th>
                  <th className="px-6 py-4 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                    Claim status
                  </th>
                  <th className="px-6 py-4 text-right text-eyebrow uppercase tracking-eyebrow text-on-surface-variant" />
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-variant/30">
                {cases.map((c, idx) => (
                  <tr
                    key={c.id}
                    className={`group cursor-pointer transition-colors hover:bg-[#F0F9FA] ${
                      idx % 2 === 1 ? 'bg-white/20' : ''
                    }`}
                  >
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-body-sm font-bold text-primary">
                          {initials(c.patientName)}
                        </div>
                        <Link
                          href={`/cases/${c.id}`}
                          className="text-body font-bold text-primary group-hover:text-primary-container"
                        >
                          {c.patientName}
                        </Link>
                      </div>
                    </td>
                    <td className="px-6 py-4 font-mono text-body-sm text-on-surface-variant">
                      {c.hospitalMrn}
                    </td>
                    <td className="px-6 py-4 text-body text-on-surface">{c.admissionDate}</td>
                    <td className="px-6 py-4">
                      <RailPill rail={c.primaryRail} />
                    </td>
                    <td className="px-6 py-4">
                      <StatusPill status={c.caseStatus} />
                    </td>
                    <td className="px-6 py-4 text-body-sm text-on-surface-variant">
                      <div className="flex flex-wrap items-center gap-2">
                        <span>{c.headlineClaimStatus ?? '—'}</span>
                        {/* T2-15 follow-up — compact IRDAI SLA pills next
                            to the claim status when the headline claim has
                            entered preauth / claim phase. The list
                            endpoint precomputes these. */}
                        {c.sla?.preauth ? <SlaPill sla={c.sla.preauth} compact /> : null}
                        {c.sla?.claim ? <SlaPill sla={c.sla.claim} compact /> : null}
                        {/* T2-14 follow-up — surface a room-rent shortfall
                            pill at the triage level so the case is visibly
                            flagged in the list, not just on its detail. */}
                        <RoomRentShortfallPill
                          roomDailyRate={c.roomDailyRate}
                          policyRoomRentLimit={c.policyRoomRentLimit}
                        />
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <Link
                        href={`/cases/${c.id}`}
                        aria-label="Open case"
                        className="text-on-surface-variant transition-colors hover:text-primary"
                      >
                        <span className="material-symbols-outlined">more_vert</span>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- helpers ----------

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const a = parts[0]?.[0] ?? '';
  const b = parts.length > 1 ? parts[parts.length - 1]![0] : '';
  return (a + b).toUpperCase();
}

function FilterChip({
  label,
  active,
  onClick,
  icon,
  tone = 'primary',
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  icon?: string;
  tone?: 'primary' | 'warning';
}): JSX.Element {
  const activeCls =
    tone === 'warning'
      ? 'border-amber-300 bg-amber-50 text-amber-700'
      : 'border-primary bg-primary/10 text-primary';
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? `inline-flex items-center gap-1 rounded-full border px-3 py-1 text-body-sm font-medium ${activeCls}`
          : 'inline-flex items-center gap-1 rounded-full border border-outline-variant/40 bg-surface-container-lowest/60 px-3 py-1 text-body-sm text-on-surface-variant hover:border-primary/40 hover:text-on-surface'
      }
      aria-pressed={active}
    >
      {icon ? (
        <span className="material-symbols-outlined text-[14px]">{icon}</span>
      ) : null}
      {label}
    </button>
  );
}

function EmptyState({
  activeFilters,
  onClearAll,
}: {
  activeFilters: number;
  onClearAll: () => void;
}): JSX.Element {
  return (
    <div className="glass flex flex-col items-center gap-3 rounded-xl py-12 text-center">
      <div
        className="flex h-14 w-14 items-center justify-center rounded-full bg-primary-fixed/30 text-primary"
        aria-hidden
      >
        <span className="material-symbols-outlined">
          {activeFilters > 0 ? 'filter_alt_off' : 'folder_open'}
        </span>
      </div>
      <div className="text-h3 font-h3 text-on-surface">
        {activeFilters > 0 ? 'No cases match the filters' : 'Nothing here yet'}
      </div>
      <p className="max-w-sm text-body-sm text-on-surface-variant">
        {activeFilters > 0
          ? 'Try clearing one or more filters to broaden the result set.'
          : 'No open cases right now. Create one to start a new claim.'}
      </p>
      {activeFilters > 0 ? (
        <button
          type="button"
          onClick={onClearAll}
          className="btn-outline mt-2"
          style={{ padding: '10px 24px', fontSize: '13px' }}
        >
          Clear all filters
        </button>
      ) : (
        <Link href="/cases/new" className="btn-cta mt-2" style={{ padding: '10px 24px' }}>
          <span
            className="material-symbols-outlined"
            style={{ fontSize: 18, fontVariationSettings: "'FILL' 1" }}
          >
            add
          </span>
          Create new case
        </Link>
      )}
    </div>
  );
}

function RailPill({ rail }: { rail: string }): JSX.Element {
  const r = rail.toLowerCase();
  const cls =
    r === 'nhcx'
      ? 'bg-purple-50 text-purple-700 border-purple-100'
      : r === 'pmjay'
        ? 'bg-blue-50 text-blue-700 border-blue-100'
        : 'bg-surface-container text-on-surface-variant border-outline-variant/50';
  const icon = r === 'nhcx' ? 'account_balance' : 'health_and_safety';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-body-sm font-medium ${cls}`}
    >
      <span className="material-symbols-outlined text-[14px]">{icon}</span>
      {rail}
    </span>
  );
}

// T2-14 follow-up — compact list-card pill that materialises only when
// both rate + cap were captured at intake AND the rate exceeds the
// cap. The math mirrors the case-detail banner; the wire shape
// (nullable Int paise) comes straight from CaseSummary.
function RoomRentShortfallPill({
  roomDailyRate,
  policyRoomRentLimit,
}: {
  roomDailyRate: number | null;
  policyRoomRentLimit: number | null;
}): JSX.Element | null {
  if (roomDailyRate === null || policyRoomRentLimit === null) return null;
  const perDayPaise = Math.max(0, roomDailyRate - policyRoomRentLimit);
  if (perDayPaise <= 0) return null;
  const perDayRupees = (perDayPaise / 100).toLocaleString('en-IN', {
    maximumFractionDigits: 0,
  });
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 font-mono text-[11px] tabular-nums text-amber-700"
      title={`Room rent exceeds policy cap by ₹${perDayRupees}/day — captured at intake`}
    >
      <span className="material-symbols-outlined text-[14px]">bed</span>
      +₹{perDayRupees}/day
    </span>
  );
}

function StatusPill({ status }: { status: string }): JSX.Element {
  const s = status.toUpperCase();
  let dot = 'bg-outline';
  let cls = 'bg-surface-container text-on-surface-variant border-outline-variant/50';
  if (s.includes('OPEN') || s.includes('ACTIVE') || s.includes('PENDING')) {
    dot = 'bg-amber-500';
    cls = 'bg-amber-50 text-amber-700 border-amber-100';
  } else if (s.includes('APPROV') || s.includes('CLOSED') || s.includes('SETTLED')) {
    dot = 'bg-green-500';
    cls = 'bg-green-50 text-green-700 border-green-100';
  } else if (s.includes('ABANDON') || s.includes('REJECT')) {
    dot = 'bg-red-500';
    cls = 'bg-red-50 text-red-700 border-red-100';
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-body-sm font-medium ${cls}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {status}
    </span>
  );
}
