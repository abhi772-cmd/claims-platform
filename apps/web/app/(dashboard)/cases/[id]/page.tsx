'use client';

import {
  type CaseDetail,
  type ClaimEventListItem,
  type ClaimStatus,
  type IntegrationMessage,
} from '@claims/contracts';
import { useEffect, useState } from 'react';

import { AppealPanel } from '../../../../components/appeal/AppealPanel';
import { ClaimPhasePanel } from '../../../../components/claim-phase/ClaimPhasePanel';
import { CommunicationsPanel } from '../../../../components/communication/CommunicationsPanel';
import { PlanPreviewCard } from '../../../../components/insurance-plan/PlanPreviewCard';
import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { PreauthPanel } from '../../../../components/preauth/PreauthPanel';
import { SettlementPanel } from '../../../../components/settlement/SettlementPanel';
import { SlaPill } from '../../../../components/sla/SlaPill';
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

  if (!detail) {
    return (
      <div className="glass max-w-md rounded-xl p-6">
        <p className="text-body text-on-surface-variant">Loading…</p>
      </div>
    );
  }
  const claim = detail.claims[0];

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6">
      {/* HEADER ROW — patient hero + financial summary */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Patient hero */}
        <section className="glass col-span-1 rounded-xl p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <span className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                Case · {detail.primaryRail.toUpperCase()}
              </span>
              <h1 className="mt-1 text-h2 font-h2 text-on-surface">{detail.patientName}</h1>
            </div>
            <StatusPill status={detail.caseStatus} />
          </div>
          <div className="mt-4 flex flex-col gap-2 text-body-sm">
            <div className="flex items-center gap-2 text-on-surface-variant">
              <span className="material-symbols-outlined text-[18px] text-outline">badge</span>
              <span>
                MRN <span className="font-mono">{detail.hospitalMrn}</span>
              </span>
            </div>
            <div className="flex items-center gap-2 text-on-surface-variant">
              <span className="material-symbols-outlined text-[18px] text-outline">event</span>
              <span>
                Admitted {detail.admissionDate} · {detail.admissionType}
              </span>
            </div>
          </div>
          {/* T2-15 — IRDAI SLA pills on the patient hero. Shows
              preauth (1h) and claim (3h) timers when each phase has
              started. Ticks every 30s while pending. */}
          {claim?.sla && (claim.sla.preauth || claim.sla.claim) ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {claim.sla.preauth ? <SlaPill sla={claim.sla.preauth} /> : null}
              {claim.sla.claim ? <SlaPill sla={claim.sla.claim} /> : null}
            </div>
          ) : null}
        </section>

        {/* Financial summary (2 cols on lg) */}
        <section className="glass col-span-1 flex flex-col justify-center rounded-xl p-6 lg:col-span-2">
          <h3 className="mb-4 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
            Financial Summary
          </h3>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <MiniStat
              label="Pre-auth amount"
              value={fmtAmount(claim?.preauthAmount)}
            />
            <MiniStat
              label="Approved"
              value={fmtAmount(claim?.approvedAmount)}
              tone="primary"
            />
            <MiniStat
              label="Pre-auth ref"
              value={claim?.preauthRefNum ?? '—'}
              mono
            />
            <MiniStat label="Claim ref" value={claim?.claimRefNum ?? '—'} mono />
          </div>
        </section>
      </div>

      {/* Insurance plan preview */}
      {claim ? (
        <PlanPreviewCard
          caseId={detail.id}
          claimId={claim.id}
          defaultPolicyNumber={policyNumber}
        />
      ) : null}

      {/* Eligibility action */}
      {claim && (claim.status === 'INITIATED' || claim.status === 'ELIGIBILITY_FAILED') ? (
        <section className="glass space-y-3 rounded-xl p-6">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">fact_check</span>
            <h3 className="text-h3 font-h3 text-on-surface">Eligibility</h3>
          </div>
          <p className="text-body-sm text-on-surface-variant">
            Verify the patient&apos;s coverage with the payer. The first call kicks off the
            eligibility cycle; you can retry from FAILED.
          </p>
          <div className="flex items-end gap-3">
            <div className="flex-1 space-y-1">
              <label
                htmlFor="policy"
                className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant"
              >
                Policy number (optional)
              </label>
              <input
                id="policy"
                value={policyNumber}
                onChange={(e) => setPolicyNumber(e.target.value)}
                placeholder="POL-XXXX-XXXX"
                className="w-full rounded-lg border border-white bg-surface-container-lowest/50 px-4 py-3 font-mono text-body-sm text-on-surface placeholder:text-outline-variant shadow-sm outline-none transition-all focus:border-primary-container focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary-container"
              />
            </div>
            <button
              onClick={runEligibility}
              disabled={running}
              className="btn-primary"
              style={{ padding: '12px 22px', fontSize: '13px' }}
            >
              <span
                className="material-symbols-outlined"
                style={{ fontSize: 18, fontVariationSettings: "'FILL' 1" }}
              >
                check_circle
              </span>
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

      {claim ? (
        <ClaimPhasePanel
          caseId={detail.id}
          claimId={claim.id}
          status={claim.status as ClaimStatus}
          onChanged={() => void reload()}
        />
      ) : null}

      {claim ? (
        <SettlementPanel
          caseId={detail.id}
          claimId={claim.id}
          status={claim.status as ClaimStatus}
          onChanged={() => void reload()}
        />
      ) : null}

      {claim ? (
        <AppealPanel
          caseId={detail.id}
          claimId={claim.id}
          status={claim.status as ClaimStatus}
          onChanged={() => void reload()}
        />
      ) : null}

      {/* Stage 5 — case-level communications timeline. Sits ABOVE
          the bottom-row timeline so the conversation is visible
          without scrolling past the entire case audit. */}
      <CommunicationsPanel
        caseId={detail.id}
        claimId={claim?.id ?? null}
        onChanged={() => void reload()}
      />

      {/* Bottom row: timeline + integration logs */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Timeline */}
        <section className="glass rounded-xl p-6">
          <div className="mb-6 flex items-center justify-between">
            <span className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
              Case timeline
            </span>
            <span className="text-body-sm text-on-surface-variant">
              {events.length} {events.length === 1 ? 'event' : 'events'}
            </span>
          </div>
          {events.length === 0 ? (
            <p className="text-body-sm text-on-surface-variant">No events yet.</p>
          ) : (
            <div className="relative space-y-6 border-l-2 border-surface-container-highest pl-6">
              {events.map((e, idx) => (
                <div key={e.id} className="relative">
                  <span
                    className={
                      idx === 0
                        ? 'absolute -left-[31px] top-1 h-3 w-3 rounded-full bg-primary ring-4 ring-background'
                        : 'absolute -left-[31px] top-1 h-3 w-3 rounded-full border-2 border-white bg-surface-variant ring-4 ring-background'
                    }
                    aria-hidden
                  />
                  <div className="font-mono text-[10px] text-on-surface-variant">
                    {new Date(e.occurredAt).toLocaleString()}
                  </div>
                  <div className="text-body font-medium text-on-surface">{e.eventType}</div>
                  <div className="mt-1 text-body-sm text-on-surface-variant">
                    → {e.resultingStatus}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Integration logs — terminal style */}
        <section className="glass flex h-[420px] flex-col overflow-hidden rounded-xl p-0">
          <div className="flex items-center justify-between border-b border-white/40 bg-surface/30 p-4">
            <span className="flex items-center gap-1 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
              <span className="material-symbols-outlined text-[14px]">terminal</span>
              Integration logs
            </span>
            <span className="rounded bg-surface-container px-2 py-0.5 font-mono text-[10px] text-on-surface-variant">
              {messages.length} msg
            </span>
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto bg-[#1A1D1E] p-4">
            {messages.length === 0 ? (
              <p className="font-mono text-[11px] text-[#A0AAB0]">{'// no integration messages yet'}</p>
            ) : (
              messages.map((m) => {
                const statusColor =
                  m.status === 'succeeded'
                    ? 'text-[#4caf50]'
                    : m.status === 'failed'
                      ? 'text-[#ff8a80]'
                      : 'text-secondary-container';
                return (
                  <div key={m.id} className="break-all font-mono text-[11px] leading-relaxed">
                    <span className="text-[#8af2fd]">
                      [{new Date(m.createdAt).toLocaleTimeString('en-IN', { hour12: false })}]
                    </span>{' '}
                    <span className={statusColor}>{m.status.toUpperCase()}</span>{' '}
                    <span className="text-white">
                      {m.integration} {m.operation} {m.direction}
                    </span>{' '}
                    <span className="text-[#A0AAB0] opacity-70">
                      corr={m.correlationId.slice(0, 8)}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

// ---- helpers ----

function fmtAmount(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n)) return String(v);
  return `₹${n.toLocaleString('en-IN')}`;
}

interface MiniStatProps {
  label: string;
  value: string;
  tone?: 'primary' | 'accent' | 'neutral';
  mono?: boolean;
}

function MiniStat({ label, value, tone = 'neutral', mono }: MiniStatProps): JSX.Element {
  const valCls =
    tone === 'primary'
      ? 'text-primary'
      : tone === 'accent'
        ? 'text-secondary-container'
        : 'text-on-surface';
  return (
    <div className="rounded-lg border border-white/40 bg-surface-container-lowest/50 p-4">
      <span className="mb-1 block text-body-sm text-on-surface-variant">{label}</span>
      <span
        className={`block ${mono ? 'font-mono text-body' : 'text-h3 font-h3 font-bold'} ${valCls}`}
      >
        {value}
      </span>
    </div>
  );
}

function StatusPill({ status }: { status: string }): JSX.Element {
  const s = status.toUpperCase();
  let cls = 'bg-surface-container text-on-surface-variant border-outline-variant/50';
  let dot = 'bg-outline';
  if (s.includes('OPEN') || s.includes('ACTIVE') || s.includes('PENDING')) {
    cls = 'bg-amber-50 text-amber-700 border-amber-100';
    dot = 'bg-amber-500';
  } else if (s.includes('APPROV') || s.includes('CLOSED') || s.includes('SETTLED')) {
    cls = 'bg-green-50 text-green-700 border-green-100';
    dot = 'bg-green-500';
  } else if (s.includes('ABANDON') || s.includes('REJECT')) {
    cls = 'bg-red-50 text-red-700 border-red-100';
    dot = 'bg-red-500';
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
