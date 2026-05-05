'use client';

import {
  type OnboardingStep,
  type OnboardingStepKey,
  type ReadinessReport,
} from '@claims/contracts';
import { useEffect, useState } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { TenantApi } from '../../../../lib/api/tenant.api';

const STEP_LABELS: Record<OnboardingStepKey, string> = {
  tenant_profile: 'Tenant profile',
  roles_assigned: 'Roles assigned',
  nhcx_cert: 'NHCX certificate',
  pmjay_state: 'PMJAY state',
  payer_master: 'Payer master',
  package_master: 'Package master',
  notification_test: 'Notification test',
  legal_acceptance: 'Legal acceptance',
};

export default function OnboardingPage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const [steps, setSteps] = useState<OnboardingStep[] | null>(null);
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function reload(): Promise<void> {
    try {
      const [s, r] = await Promise.all([
        TenantApi.listOnboardingSteps(),
        TenantApi.runReadiness(),
      ]);
      setSteps(s.steps);
      setReadiness(r);
    } catch (err) {
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

  return (
    <div className="space-y-6">
      <header className="space-y-1 rounded-md bg-neutral-0 p-6 shadow-md">
        <h1 className="text-xl font-semibold text-neutral-800">Onboarding checklist</h1>
        <p className="text-sm text-neutral-500">
          Complete these steps before requesting PILOT or LIVE.
        </p>
      </header>

      <section className="space-y-3 rounded-md bg-neutral-0 p-6 shadow-md">
        <h2 className="text-sm font-semibold text-neutral-700">Steps</h2>
        {steps === null ? (
          <p className="text-sm text-neutral-500">Loading…</p>
        ) : (
          <ul className="space-y-2">
            {steps.map((s) => (
              <li
                key={s.key}
                className="flex items-center justify-between gap-4 rounded-sm border border-neutral-200 p-3"
              >
                <div className="space-y-0.5">
                  <p className="text-sm text-neutral-700">{STEP_LABELS[s.key]}</p>
                  <p className="text-xs text-neutral-400">
                    {s.status}
                    {s.completedAt
                      ? ` · ${new Date(s.completedAt).toLocaleDateString()}`
                      : ''}
                  </p>
                </div>
                <button
                  onClick={() => markComplete(s.key)}
                  disabled={busy === s.key || s.status === 'completed'}
                  className="rounded-sm bg-primary-600 px-2 py-1 text-xs font-medium text-neutral-0 hover:bg-primary-700 disabled:opacity-60"
                >
                  {s.status === 'completed' ? 'Completed' : busy === s.key ? 'Saving…' : 'Mark complete'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3 rounded-md bg-neutral-0 p-6 shadow-md">
        <h2 className="text-sm font-semibold text-neutral-700">Readiness</h2>
        {readiness === null ? (
          <p className="text-sm text-neutral-500">Loading…</p>
        ) : (
          <div className="space-y-2">
            <p
              className={
                readiness.ready
                  ? 'text-sm font-medium text-success-700'
                  : 'text-sm font-medium text-warning-700'
              }
            >
              {readiness.ready
                ? 'Tenant is ready for PILOT/LIVE.'
                : 'Some checks still need attention.'}
            </p>
            <ul className="space-y-1">
              {readiness.items.map((i) => (
                <li
                  key={i.key}
                  className={i.ok ? 'text-xs text-success-700' : 'text-xs text-neutral-500'}
                >
                  {i.ok ? '✓' : '○'} {i.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
