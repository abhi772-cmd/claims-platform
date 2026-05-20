'use client';

import {
  ONBOARDING_STEP_DESCRIPTORS,
  type OnboardingStep,
  type OnboardingStepDescriptor,
  type OnboardingStepKey,
  type ReadinessReport,
} from '@claims/contracts';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { TenantApi } from '../../../../lib/api/tenant.api';

// Internal "go configure this step" links for steps that have a
// dedicated admin surface. Currently only payer_commercial_terms;
// extend as more steps grow their own pages.
const INTERNAL_STEP_ROUTES: Partial<Record<OnboardingStepKey, { label: string; href: string }>> = {
  payer_master: {
    label: 'Select your payers',
    href: '/admin/onboarding/payer-empanelment',
  },
  payer_commercial_terms: {
    label: 'Open payer commercial terms',
    href: '/admin/onboarding/payer-commercial-terms',
  },
};

// --- Step grouping --------------------------------------------------
// The pre-Sprint-10 page rendered a flat 8-row checklist where every
// step looked equally important. That was the single biggest
// onboarding complaint: operators couldn't tell which steps blocked
// NHCX sandbox cutover, which were paperwork, and which were just
// data uploads. We now group steps by axis and surface a top-level
// "NHCX cutover readiness" callout so an operator looking at the
// page sees their go-live blockers in the first paint.
type StepGroupKey = 'identity' | 'nhcx' | 'pmjay' | 'masters' | 'governance';

const GROUP_LABELS: Record<StepGroupKey, { title: string; subtitle: string }> = {
  identity: {
    title: 'Hospital identity',
    subtitle: 'Who you are on the platform and who owns each workflow.',
  },
  nhcx: {
    title: 'NHCX participant onboarding',
    subtitle:
      'Four discrete artefacts NHA verifies before they let your gateway send a single message. Complete in order.',
  },
  pmjay: {
    title: 'PMJAY rail',
    subtitle: 'State Health Agency configuration. Skip if you are not PMJAY-empanelled.',
  },
  masters: {
    title: 'Master data',
    subtitle: 'Payer codes, packages, and tariffs the platform bills against.',
  },
  governance: {
    title: 'Governance',
    subtitle: 'Notification smoke test + signed agreements.',
  },
};

const STEP_TO_GROUP: Record<OnboardingStepKey, StepGroupKey> = {
  tenant_profile: 'identity',
  roles_assigned: 'identity',
  hfr_facility: 'nhcx',
  nhcx_participant_code: 'nhcx',
  nhcx_cert: 'nhcx',
  nhcx_callback_url: 'nhcx',
  pmjay_state: 'pmjay',
  payer_master: 'masters',
  payer_commercial_terms: 'masters',
  package_master: 'masters',
  notification_test: 'governance',
  legal_acceptance: 'governance',
};

function descriptorFor(key: OnboardingStepKey): OnboardingStepDescriptor | undefined {
  return ONBOARDING_STEP_DESCRIPTORS.find((d) => d.key === key);
}

// --- Page -----------------------------------------------------------
export default function OnboardingPage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const [steps, setSteps] = useState<OnboardingStep[] | null>(null);
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [openStep, setOpenStep] = useState<OnboardingStepKey | null>(null);
  // Surfaces "API not reachable" inline instead of letting the page
  // silently render only the header when the steps call fails. The
  // descriptors are canonical so the rest of the UI still renders.
  const [apiError, setApiError] = useState<string | null>(null);

  async function reload(): Promise<void> {
    try {
      const [s, r] = await Promise.all([
        TenantApi.listOnboardingSteps(),
        TenantApi.runReadiness(),
      ]);
      setSteps(s.steps);
      setReadiness(r);
      setApiError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load.';
      setApiError(message);
      showApiError(err);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function markComplete(key: OnboardingStepKey): Promise<void> {
    setBusy(key);
    try {
      await TenantApi.completeOnboardingStep(key, { status: 'completed' });
      await reload();
    } catch (err) {
      showApiError(err);
    } finally {
      setBusy(null);
    }
  }

  // Descriptors are the canonical list — the page renders one row per
  // descriptor regardless of whether the API has responded. When the
  // API responds, its row data merges in; otherwise the row stays at
  // status='pending'. Keeps the wizard rendering even when the steps
  // endpoint is slow, unreachable, or returns a partial list.
  const displaySteps = useMemo<OnboardingStep[]>(() => {
    const byKey = new Map((steps ?? []).map((s) => [s.key, s]));
    return ONBOARDING_STEP_DESCRIPTORS.map(
      (d): OnboardingStep =>
        byKey.get(d.key) ?? {
          key: d.key,
          status: 'pending',
          completedAt: null,
          evidence: {},
        },
    );
  }, [steps]);

  const cutover = useMemo(() => {
    const blockers = ONBOARDING_STEP_DESCRIPTORS.filter((d) => d.blocksNhcxCutover);
    const byKey = new Map(displaySteps.map((s) => [s.key, s]));
    const blockerStatus = blockers.map((d) => ({
      ...d,
      status: byKey.get(d.key)?.status ?? ('pending' as OnboardingStep['status']),
    }));
    const blocked = blockerStatus.filter(
      (b) => b.status !== 'completed' && b.status !== 'skipped',
    );
    return {
      total: blockers.length,
      complete: blockers.length - blocked.length,
      blocked,
      ready: blocked.length === 0,
    };
  }, [displaySteps]);

  const stepsByGroup = useMemo(() => {
    const groups: Record<StepGroupKey, OnboardingStep[]> = {
      identity: [],
      nhcx: [],
      pmjay: [],
      masters: [],
      governance: [],
    };
    for (const s of displaySteps) {
      const g = STEP_TO_GROUP[s.key];
      if (g) groups[g].push(s);
    }
    return groups;
  }, [displaySteps]);

  const overall = useMemo(() => {
    const done = displaySteps.filter(
      (s) => s.status === 'completed' || s.status === 'skipped',
    ).length;
    return {
      done,
      total: displaySteps.length,
      pct: displaySteps.length
        ? Math.round((done / displaySteps.length) * 100)
        : 0,
    };
  }, [displaySteps]);

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6">
      {/* Top callout — explains the purpose of the page in one line. */}
      <header className="glass rounded-xl p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-h2 font-h2 text-on-surface">Hospital onboarding</h2>
            <p className="mt-1 max-w-2xl text-body text-on-surface-variant">
              Complete every step below before requesting PILOT or LIVE. The four NHCX
              participant steps are mandatory for any hospital that wants to send a single
              message through NHA&apos;s gateway — they cannot be skipped or worked around.
            </p>
          </div>
          <div className="min-w-[200px]">
              <div className="flex items-baseline justify-between">
                <span className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                  Progress
                </span>
                <span className="text-body font-bold text-primary">{overall.pct}%</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-container-high">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${overall.pct}%`,
                    background:
                      'linear-gradient(90deg, var(--m3-primary-container) 0%, var(--m3-primary) 100%)',
                  }}
                />
              </div>
              <div className="mt-1.5 text-body-sm text-on-surface-variant">
                {overall.done} of {overall.total} steps done
              </div>
            </div>
        </div>
      </header>

      {apiError && (
        <section className="rounded-xl border border-red-200 bg-red-50/70 p-4 text-body-sm text-red-700">
          <div className="font-semibold">Couldn&apos;t load onboarding status from the API.</div>
          <div className="mt-1 break-all text-red-700/80">{apiError}</div>
          <div className="mt-2 text-red-700/80">
            The checklist below is rendered from the canonical descriptor list; live
            progress + readiness probes will appear once the API is reachable.
          </div>
        </section>
      )}

      {/* NHCX cutover readiness banner. */}
      <section
        className={`rounded-xl border p-5 backdrop-blur-[24px] ${
          cutover.ready
            ? 'border-green-200 bg-green-50/70'
            : 'border-amber-200 bg-amber-50/70'
        }`}
      >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <div
                className={`flex h-9 w-9 items-center justify-center rounded-full ${
                  cutover.ready
                    ? 'bg-green-500/15 text-green-700'
                    : 'bg-amber-500/15 text-amber-700'
                }`}
              >
                <span
                  className="material-symbols-outlined"
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  {cutover.ready ? 'check_circle' : 'warning'}
                </span>
              </div>
              <h3 className="text-h3 font-h3 text-on-surface">
                NHCX sandbox cutover readiness
              </h3>
            </div>
            <span className="rounded-full border border-white/60 bg-white/70 px-3 py-1 text-body-sm font-semibold text-on-surface">
              {cutover.complete} / {cutover.total} blockers
            </span>
          </div>
          {cutover.ready ? (
            <p className="mt-3 text-body text-green-700">
              Every NHCX cutover blocker is satisfied. You can request PILOT / LIVE from the
              lifecycle page.
            </p>
          ) : (
            <div className="mt-3 space-y-2">
              <p className="text-body text-amber-700">
                These steps must be completed before we can promote your tenant to PILOT or
                LIVE. Each one captures an artefact NHA&apos;s gateway checks on every call.
              </p>
              <ul className="space-y-1">
                {cutover.blocked.map((b) => (
                  <li
                    key={b.key}
                    className="rounded-lg border border-white/40 bg-white/60 px-3 py-2 text-body-sm text-on-surface"
                  >
                    <span className="font-semibold">{b.title}</span> — {b.purpose}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

      {/* Step list grouped by axis. */}
      <div className="space-y-4">
          {(Object.keys(GROUP_LABELS) as StepGroupKey[]).map((groupKey) => {
            const group = GROUP_LABELS[groupKey];
            const items = stepsByGroup[groupKey];
            if (items.length === 0) return null;
            const groupDone = items.filter(
              (s) => s.status === 'completed' || s.status === 'skipped',
            ).length;
            return (
              <section key={groupKey} className="glass rounded-xl p-6">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-h3 font-h3 text-on-surface">{group.title}</h3>
                    <p className="mt-1 text-body-sm text-on-surface-variant">
                      {group.subtitle}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full border border-outline-variant/50 bg-surface-container-low px-3 py-1 text-body-sm font-semibold text-on-surface-variant">
                    {groupDone}/{items.length}
                  </span>
                </div>
                <ul className="mt-3 space-y-2">
                  {items.map((s) => (
                    <StepRow
                      key={s.key}
                      step={s}
                      descriptor={descriptorFor(s.key)}
                      busy={busy === s.key}
                      open={openStep === s.key}
                      onToggle={() => setOpenStep((cur) => (cur === s.key ? null : s.key))}
                      onMarkComplete={() => markComplete(s.key)}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>

      {/* Detailed readiness items — the per-check breakdown the API
          returns. Kept as a separate audit panel so the step list
          above stays the primary action surface. */}
      {readiness && (
        <section className="glass rounded-xl p-6">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">monitoring</span>
            <h3 className="text-h3 font-h3 text-on-surface">Readiness checks</h3>
          </div>
          <p className="mt-2 text-body-sm text-on-surface-variant">
            Live signals from the readiness probe. These differ from the checklist above —
            probes run against actual database state (e.g. &quot;at least one MFA-enrolled admin
            exists&quot;) rather than self-attestation.
          </p>
          <p
            className={
              readiness.ready
                ? 'mt-4 text-body font-semibold text-green-700'
                : 'mt-4 text-body font-semibold text-amber-700'
            }
          >
            {readiness.ready
              ? 'All readiness probes pass.'
              : `${readiness.items.filter((i) => !i.ok).length} probe(s) failing.`}
          </p>
          <ul className="mt-3 space-y-1.5">
            {readiness.items.map((i) => (
              <li
                key={i.key}
                className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-body-sm ${
                  i.ok
                    ? 'border-green-100 bg-green-50 text-green-700'
                    : 'border-amber-100 bg-amber-50 text-amber-700'
                }`}
              >
                <span className="material-symbols-outlined text-[18px]">
                  {i.ok ? 'check_circle' : 'radio_button_unchecked'}
                </span>
                <span>{i.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// --- Single step row -----------------------------------------------
// Collapsed: title + status + primary action.
// Expanded: purpose, captures, external action, evidence preview.
function StepRow({
  step,
  descriptor,
  busy,
  open,
  onToggle,
  onMarkComplete,
}: {
  step: OnboardingStep;
  descriptor: OnboardingStepDescriptor | undefined;
  busy: boolean;
  open: boolean;
  onToggle: () => void;
  onMarkComplete: () => void;
}): JSX.Element {
  const title = descriptor?.title ?? step.key;
  const statusBadge = (() => {
    switch (step.status) {
      case 'completed':
        return {
          label: 'Completed',
          cls: 'bg-green-50 text-green-700 border-green-100',
          dot: 'bg-green-500',
        };
      case 'in_progress':
        return {
          label: 'In progress',
          cls: 'bg-blue-50 text-blue-700 border-blue-100',
          dot: 'bg-blue-500',
        };
      case 'skipped':
        return {
          label: 'Skipped',
          cls: 'bg-surface-container text-on-surface-variant border-outline-variant/50',
          dot: 'bg-outline',
        };
      default:
        return {
          label: 'Not started',
          cls: 'bg-amber-50 text-amber-700 border-amber-100',
          dot: 'bg-amber-500',
        };
    }
  })();
  const done = step.status === 'completed';
  return (
    <li
      className={`overflow-hidden rounded-lg border bg-surface-container-lowest/50 ${done ? 'border-green-200' : 'border-outline-variant/40'}`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 p-4 text-left transition hover:bg-primary/5"
      >
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className={`flex h-7 w-7 items-center justify-center rounded-full ${
              done
                ? 'bg-green-500/15 text-green-700'
                : 'bg-surface-container text-on-surface-variant'
            }`}
          >
            <span
              className="material-symbols-outlined text-[18px]"
              style={done ? { fontVariationSettings: "'FILL' 1" } : undefined}
            >
              {done ? 'check_circle' : open ? 'expand_less' : 'expand_more'}
            </span>
          </span>
          <div>
            <p className="text-body font-semibold text-on-surface">{title}</p>
            {descriptor?.purpose && (
              <p className="text-body-sm text-on-surface-variant">{descriptor.purpose}</p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {descriptor?.blocksNhcxCutover &&
            step.status !== 'completed' &&
            step.status !== 'skipped' && (
              <span
                title="Blocks NHCX sandbox cutover"
                className="inline-flex items-center gap-1 rounded-full border border-amber-100 bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-700"
              >
                <span className="h-1 w-1 animate-pulse rounded-full bg-amber-500" />
                Cutover
              </span>
            )}
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-body-sm font-medium ${statusBadge.cls}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${statusBadge.dot}`} />
            {statusBadge.label}
          </span>
        </div>
      </button>
      {open && (
        <div className="space-y-4 border-t border-outline-variant/40 bg-white/40 p-5">
          {descriptor?.captures && descriptor.captures.length > 0 && (
            <div>
              <p className="mb-2 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                What this step captures
              </p>
              <ul className="ml-5 list-disc space-y-0.5 text-body-sm text-on-surface-variant">
                {descriptor.captures.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          {descriptor?.externalAction && (
            <div>
              <p className="mb-2 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                How to complete
              </p>
              <a
                href={descriptor.externalAction.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-body-sm font-medium text-primary transition-colors hover:text-primary-container"
              >
                {descriptor.externalAction.label}
                <span className="material-symbols-outlined text-[16px]">open_in_new</span>
              </a>
            </div>
          )}
          {INTERNAL_STEP_ROUTES[step.key] && (
            <div>
              <p className="mb-2 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                Configure
              </p>
              <Link
                href={INTERNAL_STEP_ROUTES[step.key]!.href}
                className="inline-flex items-center gap-1 text-body-sm font-medium text-primary transition-colors hover:text-primary-container"
              >
                {INTERNAL_STEP_ROUTES[step.key]!.label}
                <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
              </Link>
            </div>
          )}
          {step.completedAt && (
            <p className="text-body-sm text-on-surface-variant">
              Completed {new Date(step.completedAt).toLocaleString()}
            </p>
          )}
          {Object.keys(step.evidence ?? {}).length > 0 && (
            <div>
              <p className="mb-2 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                Recorded evidence
              </p>
              <pre className="overflow-x-auto rounded-lg bg-[#1A1D1E] p-3 font-mono text-[11px] text-[#A0AAB0]">
                {JSON.stringify(step.evidence, null, 2)}
              </pre>
            </div>
          )}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onMarkComplete}
              disabled={busy || step.status === 'completed'}
              className="btn-primary"
              style={{ padding: '8px 18px', fontSize: '13px' }}
            >
              <span
                className="material-symbols-outlined text-[18px]"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                check_circle
              </span>
              {step.status === 'completed' ? 'Completed' : busy ? 'Saving…' : 'Mark complete'}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
