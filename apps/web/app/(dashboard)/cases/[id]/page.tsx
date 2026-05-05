'use client';

import {
  type CaseDetail,
  type ClaimEventListItem,
} from '@claims/contracts';
import { useEffect, useState } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { CaseApi } from '../../../../lib/api/case.api';

interface PageProps {
  params: { id: string };
}

export default function CaseDetailPage({ params }: PageProps): JSX.Element {
  const { showApiError } = useErrorModal();
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [events, setEvents] = useState<ClaimEventListItem[]>([]);

  async function reload(): Promise<void> {
    try {
      const d = await CaseApi.getById(params.id);
      setDetail(d);
      const firstClaim = d.claims[0];
      if (firstClaim) {
        const e = await CaseApi.listClaimEvents(d.id, firstClaim.id);
        setEvents(e.events);
      }
    } catch (err) {
      showApiError(err);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  if (!detail) return <p className="text-sm text-neutral-500">Loading…</p>;
  const claim = detail.claims[0];

  return (
    <div className="space-y-6">
      <section className="space-y-1 rounded-md bg-neutral-0 p-6 shadow-md">
        <h1 className="text-xl font-semibold text-neutral-800">{detail.patientName}</h1>
        <p className="text-sm text-neutral-500">
          MRN <span className="font-mono">{detail.hospitalMrn}</span> · {detail.admissionType} ·
          admitted {detail.admissionDate} · rail {detail.primaryRail.toUpperCase()}
        </p>
        <p className="text-xs text-neutral-400">
          Case status: <span className="font-medium text-neutral-700">{detail.caseStatus}</span>
        </p>
      </section>

      {claim ? (
        <section className="space-y-3 rounded-md bg-neutral-0 p-6 shadow-md">
          <header className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-700">Claim</h2>
            <span className="rounded-sm bg-primary-50 px-2 py-0.5 text-xs font-medium text-primary-700">
              {claim.status}
            </span>
          </header>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
            <dt className="text-neutral-500">Pre-auth amount</dt>
            <dd className="text-neutral-700">{claim.preauthAmount ?? '—'}</dd>
            <dt className="text-neutral-500">Approved amount</dt>
            <dd className="text-neutral-700">{claim.approvedAmount ?? '—'}</dd>
            <dt className="text-neutral-500">Pre-auth ref</dt>
            <dd className="font-mono text-neutral-700">{claim.preauthRefNum ?? '—'}</dd>
            <dt className="text-neutral-500">Claim ref</dt>
            <dd className="font-mono text-neutral-700">{claim.claimRefNum ?? '—'}</dd>
          </dl>
        </section>
      ) : null}

      <section className="space-y-3 rounded-md bg-neutral-0 p-6 shadow-md">
        <h2 className="text-sm font-semibold text-neutral-700">Timeline</h2>
        {events.length === 0 ? (
          <p className="text-xs text-neutral-500">No events yet.</p>
        ) : (
          <ol className="space-y-2">
            {events.map((e) => (
              <li key={e.id} className="rounded-sm border border-neutral-100 p-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-neutral-700">{e.eventType}</span>
                  <span className="text-neutral-400">
                    {new Date(e.occurredAt).toLocaleString()}
                  </span>
                </div>
                <p className="text-neutral-500">→ {e.resultingStatus}</p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
