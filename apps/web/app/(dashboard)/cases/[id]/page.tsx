'use client';

import {
  type CaseDetail,
  type ClaimEventListItem,
  type ClaimStatus,
  type IntegrationMessage,
} from '@claims/contracts';
import { useEffect, useState } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { PreauthPanel } from '../../../../components/preauth/PreauthPanel';
import { CaseApi } from '../../../../lib/api/case.api';

interface PageProps {
  params: { id: string };
}

export default function CaseDetailPage({ params }: PageProps): JSX.Element {
  const { showApiError } = useErrorModal();
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [events, setEvents] = useState<ClaimEventListItem[]>([]);
  const [messages, setMessages] = useState<IntegrationMessage[]>([]);
  const [policyNumber, setPolicyNumber] = useState('');
  const [running, setRunning] = useState(false);

  async function reload(): Promise<void> {
    try {
      const d = await CaseApi.getById(params.id);
      setDetail(d);
      const firstClaim = d.claims[0];
      if (firstClaim) {
        const [e, m] = await Promise.all([
          CaseApi.listClaimEvents(d.id, firstClaim.id),
          CaseApi.listIntegrationMessages(d.id, firstClaim.id),
        ]);
        setEvents(e.events);
        setMessages(m.messages);
      }
    } catch (err) {
      showApiError(err);
    }
  }

  async function runEligibility(): Promise<void> {
    if (!detail || !detail.claims[0]) return;
    setRunning(true);
    try {
      await CaseApi.runEligibility(detail.id, detail.claims[0].id, {
        ...(policyNumber ? { policyNumber } : {}),
      });
      await reload();
    } catch (err) {
      showApiError(err);
    } finally {
      setRunning(false);
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

      {claim && (claim.status === 'INITIATED' || claim.status === 'ELIGIBILITY_FAILED') ? (
        <section className="space-y-3 rounded-md bg-neutral-0 p-6 shadow-md">
          <h2 className="text-sm font-semibold text-neutral-700">Eligibility</h2>
          <p className="text-xs text-neutral-500">
            Verify the patient&apos;s coverage with the payer. The first call kicks off the
            eligibility cycle; you can retry from FAILED.
          </p>
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <label htmlFor="policy" className="text-xs text-neutral-500">
                Policy number (optional)
              </label>
              <input
                id="policy"
                value={policyNumber}
                onChange={(e) => setPolicyNumber(e.target.value)}
                className="w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 font-mono text-xs"
              />
            </div>
            <button
              onClick={runEligibility}
              disabled={running}
              className="rounded-sm bg-primary-600 px-3 py-2 text-xs font-medium text-neutral-0 hover:bg-primary-700 disabled:opacity-60"
            >
              {running ? 'Running…' : 'Verify eligibility'}
            </button>
          </div>
        </section>
      ) : null}

      {claim ? (
        <PreauthPanel
          caseId={detail.id}
          claimId={claim.id}
          status={claim.status as ClaimStatus}
          onChanged={() => void reload()}
        />
      ) : null}

      {messages.length > 0 ? (
        <section className="space-y-3 rounded-md bg-neutral-0 p-6 shadow-md">
          <h2 className="text-sm font-semibold text-neutral-700">Integration messages</h2>
          <ul className="space-y-1">
            {messages.map((m) => (
              <li key={m.id} className="rounded-sm border border-neutral-100 p-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-neutral-700">
                    {m.integration} · {m.operation} · {m.direction}
                  </span>
                  <span
                    className={
                      m.status === 'succeeded'
                        ? 'text-success-700'
                        : m.status === 'failed'
                          ? 'text-error-700'
                          : 'text-neutral-500'
                    }
                  >
                    {m.status}
                  </span>
                </div>
                <p className="text-neutral-400">
                  corr <span className="font-mono">{m.correlationId.slice(0, 8)}</span> ·
                  {' '}
                  {new Date(m.createdAt).toLocaleString()}
                </p>
              </li>
            ))}
          </ul>
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
