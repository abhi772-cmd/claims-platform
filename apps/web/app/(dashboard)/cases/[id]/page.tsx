'use client';

import {
  type CaseDetail,
  type ClaimEventListItem,
  type ClaimStatus,
  type IntegrationMessage,
} from '@claims/contracts';
import { useEffect, useState } from 'react';

import { AppealPanel } from '../../../../components/appeal/AppealPanel';
import { BiometricGateCard } from '../../../../components/biometric/BiometricGateCard';
import { ClaimPhasePanel } from '../../../../components/claim-phase/ClaimPhasePanel';
import { CommunicationsPanel } from '../../../../components/communication/CommunicationsPanel';
import { NonMedicalStripCalculator } from '../../../../components/discharge/NonMedicalStripCalculator';
import { EnhancementPanel } from '../../../../components/enhancement/EnhancementPanel';
import { AssigneeWidget } from '../../../../components/claim/AssigneeWidget';
import { PlanPreviewCard } from '../../../../components/insurance-plan/PlanPreviewCard';
import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { useToast } from '../../../../components/toast/ToastProvider';
import { PreauthPanel } from '../../../../components/preauth/PreauthPanel';
import { EobLineMatchesPanel } from '../../../../components/settlement/EobLineMatchesPanel';
import { SettlementPanel } from '../../../../components/settlement/SettlementPanel';
import { SlaPill } from '../../../../components/sla/SlaPill';
import { LoadingShimmer } from '../../../../components/ui/LoadingShimmer';
import { CaseApi } from '../../../../lib/api/case.api';

interface PageProps {
  params: { id: string };
}

export default function CaseDetailPage({ params }: PageProps): JSX.Element {
  const { showApiError } = useErrorModal();
  const showToast = useToast();
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
      const out = await CaseApi.runEligibility(detail.id, detail.claims[0].id, {
        ...(policyNumber ? { policyNumber } : {}),
      });
      // Eligibility returns a verified flag — toast accordingly so
      // the operator sees the outcome of the call, not just an
      // implicit panel rerender.
      if (out.verified) {
        showToast({
          tone: 'success',
          message: out.planName
            ? `Coverage verified: ${out.planName}.`
            : 'Coverage verified by payer.',
        });
      } else {
        showToast({
          tone: 'warning',
          message: out.failureReason
            ? `Coverage check failed: ${out.failureReason}`
            : 'Coverage check failed — retry from the eligibility section.',
        });
      }
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
    return <LoadingShimmer variant="page" label="Loading case detail" />;
  }
  const claim = detail.claims[0];

  // T2-14 — room-rent pre-warn banner. Computes liability from
  // the three fields the operator captured at intake. Skip the
  // banner entirely when either rate or limit is null (we have
  // no information to warn about). Math mirrors the server-side
  // helper apps/api/src/modules/case/room-rent-liability.ts.
  const roomRate = detail.roomDailyRate;
  const roomLimit = detail.policyRoomRentLimit;
  const stayDays = detail.estimatedStayDays;
  const perDayLiabilityPaise =
    roomRate !== null && roomLimit !== null ? Math.max(0, roomRate - roomLimit) : null;
  const totalLiabilityPaise =
    perDayLiabilityPaise !== null && stayDays !== null
      ? perDayLiabilityPaise * stayDays
      : null;

  // T2-8 — auto-suggest enhancement when current room > admission room.
  const currentRoomRate = detail.currentRoomDailyRate;
  const wardUpgradedPaise =
    currentRoomRate !== null && roomRate !== null && currentRoomRate > roomRate
      ? currentRoomRate - roomRate
      : null;
  const suggestedTopUpPaise =
    wardUpgradedPaise !== null && stayDays !== null
      ? wardUpgradedPaise * stayDays
      : null;

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6">
      {perDayLiabilityPaise !== null && perDayLiabilityPaise > 0 ? (
        <section
          className="glass rounded-xl border border-amber-300 bg-amber-50/70 p-5"
          role="alert"
        >
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined mt-0.5 text-amber-700">warning</span>
            <div className="flex-1 text-body-sm">
              <p className="text-h3 font-h3 text-on-surface">
                Room rent exceeds policy cap by ₹{fmtINR(perDayLiabilityPaise / 100)}/day
              </p>
              <p className="mt-1 text-on-surface-variant">
                Captured at intake: room ₹{fmtINR((roomRate ?? 0) / 100)}/day vs policy cap ₹
                {fmtINR((roomLimit ?? 0) / 100)}/day.
                {totalLiabilityPaise !== null ? (
                  <>
                    {' '}
                    Projected out-of-pocket over {stayDays} day{stayDays === 1 ? '' : 's'}:{' '}
                    <span className="font-bold text-on-surface">
                      ₹{fmtINR(totalLiabilityPaise / 100)}
                    </span>
                    .
                  </>
                ) : null}{' '}
                Verify the family has acknowledged the differential, and remember
                that most Indian policies apply a proportionate deduction on
                associated services on top of this room-rent shortfall.
              </p>
            </div>
          </div>
        </section>
      ) : null}

      {/* T2-8 — ICU upgrade tracker + auto-suggest. Always visible
          when we have the admission room rate captured; lets the
          operator record the current ward AND surfaces a CTA when
          the current rate has risen above admission. */}
      {roomRate !== null ? (
        <WardTrackerCard
          caseId={detail.id}
          admissionRate={roomRate}
          currentRate={currentRoomRate}
          wardUpgradedPaise={wardUpgradedPaise}
          suggestedTopUpPaise={suggestedTopUpPaise}
          stayDays={stayDays}
          onChanged={() => void reload()}
        />
      ) : null}

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
            <div className="flex flex-col items-end gap-2">
              <StatusPill status={detail.caseStatus} />
              {claim ? (
                <AssigneeWidget
                  caseId={detail.id}
                  claimId={claim.id}
                  assignedToUserId={claim.assignedToUserId}
                  onChanged={() => void reload()}
                />
              ) : null}
            </div>
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
            Financial summary
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

      {/* PMJAY beneficiary BIS biometric gate. Self-hides for
          non-PMJAY cases and after the operator records a
          verification (or OTP fallback). */}
      {claim ? (
        <BiometricGateCard caseId={detail.id} rail={detail.primaryRail} />
      ) : null}

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
          rail={detail.primaryRail}
          admissionType={detail.admissionType}
          onChanged={() => void reload()}
        />
      ) : null}

      {/* T2-8 — preauth enhancement panel. Self-hides for statuses
          that don't qualify (pre-approval / post-discharge). The
          panel itself is the operator action surface; the
          WardTrackerCard above is the auto-suggest. */}
      {claim ? (
        <EnhancementPanel
          caseId={detail.id}
          claimId={claim.id}
          status={claim.status as ClaimStatus}
          priorPreauthAmount={claim.preauthAmount}
          suggestedTopUpPaise={suggestedTopUpPaise}
          onChanged={() => void reload()}
        />
      ) : null}

      {/* T2-13 — non-medical strip calculator sits just above the
          ClaimPhasePanel so the operator can decide the right
          finalAmount before typing it into the panel below. With
          caseId + claimId provided, the calculator persists the
          classified bill against the claim (T2-13 follow-up) so
          a later EOB-line matcher can cross-reference. */}
      {claim ? (
        <NonMedicalStripCalculator caseId={detail.id} claimId={claim.id} />
      ) : null}

      {claim ? (
        <ClaimPhasePanel
          caseId={detail.id}
          claimId={claim.id}
          status={claim.status as ClaimStatus}
          rail={detail.primaryRail}
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

      {/* EOB-line matcher Phase 1 — suggested mapping between
          payer deductions and hospital-classified bill rows.
          Self-hides when the claim isn't adjudicated or there
          are no deductions/bill lines to compare. */}
      {claim ? (
        <EobLineMatchesPanel
          caseId={detail.id}
          claimId={claim.id}
          status={claim.status as ClaimStatus}
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

// ---- T2-8 ward tracker card ----
//
// Inline operator-facing card that:
//   * records the current room daily rate (PATCH /cases/:id with
//     currentRoomDailyRate)
//   * auto-suggests a preauth enhancement when current rate >
//     admission rate, with the delta + projected total
//
// Uses the existing CaseApi.update path; the audit_log row is
// written server-side. Renders inside the case-detail page so the
// banner sits near the T2-14 room-rent banner.

interface WardTrackerCardProps {
  caseId: string;
  admissionRate: number;
  currentRate: number | null;
  wardUpgradedPaise: number | null;
  suggestedTopUpPaise: number | null;
  stayDays: number | null;
  onChanged: () => void;
}

function WardTrackerCard({
  caseId,
  admissionRate,
  currentRate,
  wardUpgradedPaise,
  suggestedTopUpPaise,
  stayDays,
  onChanged,
}: WardTrackerCardProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draftRupees, setDraftRupees] = useState(
    currentRate !== null ? Math.round(currentRate / 100).toString() : '',
  );
  const [working, setWorking] = useState(false);
  const isUpgraded = wardUpgradedPaise !== null && wardUpgradedPaise > 0;

  const save = async (): Promise<void> => {
    const rupees = draftRupees.trim() === '' ? null : Number(draftRupees);
    if (rupees !== null && (!Number.isFinite(rupees) || rupees < 0)) return;
    setWorking(true);
    try {
      await CaseApi.update(caseId, {
        currentRoomDailyRate: rupees === null ? null : Math.round(rupees * 100),
      });
      setEditing(false);
      onChanged();
    } catch (err) {
      // ErrorModal surfaces the failure; close the editor regardless.
      setEditing(false);
      void err;
    } finally {
      setWorking(false);
    }
  };

  return (
    <section
      className={
        isUpgraded
          ? 'glass rounded-xl border border-amber-300 bg-amber-50/70 p-5'
          : 'glass rounded-xl p-5'
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span
            className={
              isUpgraded
                ? 'material-symbols-outlined mt-0.5 text-amber-700'
                : 'material-symbols-outlined mt-0.5 text-primary'
            }
          >
            {isUpgraded ? 'trending_up' : 'bed'}
          </span>
          <div>
            <h3 className="text-h3 font-h3 text-on-surface">
              {isUpgraded
                ? 'Ward upgrade detected — consider preauth enhancement'
                : 'Current ward tracker'}
            </h3>
            <p className="mt-1 text-body-sm text-on-surface-variant">
              Admission room rate ₹{fmtINR(admissionRate / 100)}/day
              {currentRate !== null ? (
                <>
                  {' '}
                  · current ₹{fmtINR(currentRate / 100)}/day
                  {isUpgraded && wardUpgradedPaise !== null ? (
                    <>
                      {' '}
                      ·{' '}
                      <span className="font-bold text-amber-700">
                        +₹{fmtINR(wardUpgradedPaise / 100)}/day differential
                      </span>
                      {suggestedTopUpPaise !== null && stayDays !== null ? (
                        <>
                          {' '}
                          ≈ +₹{fmtINR(suggestedTopUpPaise / 100)} over {stayDays} day
                          {stayDays === 1 ? '' : 's'}
                        </>
                      ) : null}
                    </>
                  ) : null}
                </>
              ) : (
                ' · current not yet recorded'
              )}
            </p>
          </div>
        </div>
        {!editing ? (
          <button
            type="button"
            onClick={() => {
              setDraftRupees(currentRate !== null ? Math.round(currentRate / 100).toString() : '');
              setEditing(true);
            }}
            className="text-body-sm text-primary hover:underline"
          >
            {currentRate !== null ? 'Update' : 'Record current ward rate'}
          </button>
        ) : null}
      </div>

      {editing ? (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label
              htmlFor="ward-rate"
              className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant"
            >
              Current room daily rate (₹)
            </label>
            <input
              id="ward-rate"
              inputMode="numeric"
              value={draftRupees}
              onChange={(e) => setDraftRupees(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="e.g. 15000 (ICU)"
              className="w-56 rounded-lg border border-white bg-surface-container-lowest/50 px-4 py-2 font-mono text-body text-on-surface placeholder:text-outline-variant shadow-sm outline-none focus:border-primary-container focus:ring-1 focus:ring-primary-container"
            />
          </div>
          <button
            type="button"
            onClick={() => void save()}
            disabled={working}
            className="btn-primary"
            style={{ padding: '10px 18px', fontSize: '13px' }}
          >
            {working ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="text-body-sm text-on-surface-variant hover:text-primary"
          >
            Cancel
          </button>
        </div>
      ) : null}

      {isUpgraded ? (
        <p className="mt-3 text-body-sm text-on-surface-variant">
          Scroll to the &ldquo;Pre-auth enhancement&rdquo; panel below to start the
          enhancement request with this delta pre-filled.
        </p>
      ) : null}
    </section>
  );
}

// ---- helpers ----

function fmtAmount(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n)) return String(v);
  return `₹${n.toLocaleString('en-IN')}`;
}

function fmtINR(rupees: number): string {
  return rupees.toLocaleString('en-IN', { maximumFractionDigits: 0 });
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
