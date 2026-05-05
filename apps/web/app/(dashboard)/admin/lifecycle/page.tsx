'use client';

import {
  type LifecycleStateResponse,
  type TenantLifecycleState,
} from '@claims/contracts';
import { useEffect, useState } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { TenantApi } from '../../../../lib/api/tenant.api';

const STATE_LABELS: Record<TenantLifecycleState, { label: string; tone: string }> = {
  CONTRACTED:   { label: 'Contracted',   tone: 'text-neutral-600' },
  PROVISIONING: { label: 'Provisioning', tone: 'text-neutral-600' },
  IN_SETUP:     { label: 'In setup',     tone: 'text-warning-700' },
  PILOT:        { label: 'Pilot',        tone: 'text-primary-700' },
  LIVE:         { label: 'Live',         tone: 'text-success-700' },
  SUSPENDED:    { label: 'Suspended',    tone: 'text-error-700' },
  CHURNED:      { label: 'Churned',      tone: 'text-neutral-500' },
};

export default function LifecyclePage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const [state, setState] = useState<LifecycleStateResponse | null>(null);
  const [busy, setBusy] = useState<TenantLifecycleState | null>(null);
  const [reason, setReason] = useState('');

  async function reload(): Promise<void> {
    try {
      const out = await TenantApi.getLifecycle();
      setState(out);
    } catch (err) {
      showApiError(err);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function transition(target: TenantLifecycleState): Promise<void> {
    setBusy(target);
    try {
      const out = await TenantApi.transitionLifecycle(
        reason ? { target, reason } : { target },
      );
      setState(out);
      setReason('');
    } catch (err) {
      showApiError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4 rounded-md bg-neutral-0 p-6 shadow-md">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-800">Tenant lifecycle</h1>
        <p className="text-sm text-neutral-500">
          Apply lifecycle transitions. Going to PILOT or LIVE requires the readiness check
          to pass.
        </p>
      </header>
      {state === null ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-neutral-700">
            Current state:{' '}
            <span className={`font-medium ${STATE_LABELS[state.state].tone}`}>
              {STATE_LABELS[state.state].label}
            </span>
          </p>
          {state.allowedTargets.length === 0 ? (
            <p className="text-sm text-neutral-500">No transitions available from this state.</p>
          ) : (
            <div className="space-y-2">
              <input
                type="text"
                placeholder="Optional reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 text-sm"
              />
              <div className="flex flex-wrap gap-2">
                {state.allowedTargets.map((t) => (
                  <button
                    key={t}
                    onClick={() => transition(t)}
                    disabled={busy === t}
                    className="rounded-sm border border-neutral-200 px-3 py-1 text-xs hover:bg-neutral-50 disabled:opacity-60"
                  >
                    {busy === t ? 'Applying…' : `→ ${STATE_LABELS[t].label}`}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
