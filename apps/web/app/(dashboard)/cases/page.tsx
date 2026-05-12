'use client';

import { type CaseSummary } from '@claims/contracts';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { useErrorModal } from '../../../components/modals/ErrorModal/ErrorModalProvider';
import { CaseApi } from '../../../lib/api/case.api';

type Filter = 'all' | 'open' | 'closed' | 'abandoned';

const FILTER_LABEL: Record<Filter, string> = {
  all: 'All Cases',
  open: 'Open',
  closed: 'Closed',
  abandoned: 'Abandoned',
};

const FILTERS: Filter[] = ['all', 'open', 'closed', 'abandoned'];

export default function CasesListPage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const [cases, setCases] = useState<CaseSummary[] | null>(null);
  const [filter, setFilter] = useState<Filter>('open');

  useEffect(() => {
    let cancelled = false;
    setCases(null);
    CaseApi.list(filter === 'all' ? {} : { status: filter })
      .then((r) => {
        if (!cancelled) setCases(r.cases);
      })
      .catch((err: unknown) => {
        if (!cancelled) showApiError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [filter, showApiError]);

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

      {/* Filter bar */}
      <div className="glass inline-flex self-start rounded-xl p-2 shadow-[0_2px_12px_rgba(0,102,110,0.03)]">
        {FILTERS.map((s) => {
          const active = filter === s;
          return (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={
                active
                  ? 'rounded-lg border border-white bg-white/80 px-5 py-1.5 text-body font-bold text-primary shadow-sm'
                  : 'rounded-lg px-5 py-1.5 text-body text-on-surface-variant transition-colors hover:bg-white/40'
              }
            >
              {FILTER_LABEL[s]}
            </button>
          );
        })}
        <div className="ml-3 flex items-center pr-3 text-body-sm text-on-surface-variant">
          {cases === null ? '…' : `${cases.length} ${cases.length === 1 ? 'case' : 'cases'}`}
        </div>
      </div>

      {/* Body */}
      {cases === null ? (
        <div className="glass rounded-xl p-6">
          <p className="text-body text-on-surface-variant">Loading…</p>
        </div>
      ) : cases.length === 0 ? (
        <EmptyState filter={filter} />
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
                      {c.headlineClaimStatus ?? '—'}
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

function EmptyState({ filter }: { filter: Filter }): JSX.Element {
  const copy: Record<Filter, string> = {
    open: 'No open cases right now. Create one to start a new claim.',
    closed: 'No closed cases yet.',
    abandoned: 'No abandoned cases.',
    all: 'No cases for this tenant yet.',
  };
  return (
    <div className="glass flex flex-col items-center gap-3 rounded-xl py-12 text-center">
      <div
        className="flex h-14 w-14 items-center justify-center rounded-full bg-primary-fixed/30 text-primary"
        aria-hidden
      >
        <span className="material-symbols-outlined">folder_open</span>
      </div>
      <div className="text-h3 font-h3 text-on-surface">Nothing here yet</div>
      <p className="max-w-sm text-body-sm text-on-surface-variant">{copy[filter]}</p>
      <Link href="/cases/new" className="btn-cta mt-2" style={{ padding: '10px 24px' }}>
        <span
          className="material-symbols-outlined"
          style={{ fontSize: 18, fontVariationSettings: "'FILL' 1" }}
        >
          add
        </span>
        Create new case
      </Link>
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
