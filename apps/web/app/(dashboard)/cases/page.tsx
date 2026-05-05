'use client';

import { type CaseSummary } from '@claims/contracts';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { useErrorModal } from '../../../components/modals/ErrorModal/ErrorModalProvider';
import { CaseApi } from '../../../lib/api/case.api';

export default function CasesListPage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const [cases, setCases] = useState<CaseSummary[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'open' | 'closed' | 'abandoned'>('open');

  useEffect(() => {
    let cancelled = false;
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
    <div className="space-y-4 rounded-md bg-neutral-0 p-6 shadow-md">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-neutral-800">Cases</h1>
          <p className="text-sm text-neutral-500">All claim cases for your tenant.</p>
        </div>
        <Link
          href="/cases/new"
          className="rounded-sm bg-primary-600 px-3 py-2 text-sm font-medium text-neutral-0 hover:bg-primary-700"
        >
          New case
        </Link>
      </header>

      <div className="flex gap-2 text-xs">
        {(['open', 'closed', 'abandoned', 'all'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`rounded-sm border px-3 py-1 ${
              filter === s
                ? 'border-primary-600 bg-primary-50 text-primary-700'
                : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {cases === null ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : cases.length === 0 ? (
        <p className="text-sm text-neutral-500">No cases match.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-neutral-500">
            <tr>
              <th className="py-2">Patient</th>
              <th className="py-2">MRN</th>
              <th className="py-2">Admission</th>
              <th className="py-2">Rail</th>
              <th className="py-2">Status</th>
              <th className="py-2">Claim</th>
            </tr>
          </thead>
          <tbody>
            {cases.map((c) => (
              <tr key={c.id} className="border-t border-neutral-100">
                <td className="py-2">
                  <Link href={`/cases/${c.id}`} className="text-primary-600 hover:underline">
                    {c.patientName}
                  </Link>
                </td>
                <td className="py-2 font-mono text-xs text-neutral-600">{c.hospitalMrn}</td>
                <td className="py-2 text-xs text-neutral-600">{c.admissionDate}</td>
                <td className="py-2 text-xs uppercase text-neutral-500">{c.primaryRail}</td>
                <td className="py-2 text-xs text-neutral-700">{c.caseStatus}</td>
                <td className="py-2 text-xs text-neutral-600">
                  {c.headlineClaimStatus ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
