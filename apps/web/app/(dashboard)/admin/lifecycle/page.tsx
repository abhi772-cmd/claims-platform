'use client';

import { type LifecycleStateResponse, type TenantLifecycleState } from '@claims/contracts';
import { useEffect, useState } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { TenantApi } from '../../../../lib/api/tenant.api';

const STATE_LABELS: Record<
  TenantLifecycleState,
  { label: string; cls: string; dot: string }
> = {
  CONTRACTED: { label: 'Contracted', cls: 'bg-surface-container text-on-surface-variant border-outline-variant/50', dot: 'bg-outline' },
  PROVISIONING: { label: 'Provisioning', cls: 'bg-surface-container text-on-surface-variant border-outline-variant/50', dot: 'bg-outline' },
  IN_SETUP: { label: 'In setup', cls: 'bg-amber-50 text-amber-700 border-amber-100', dot: 'bg-amber-500' },
  PILOT: { label: 'Pilot', cls: 'bg-blue-50 text-blue-700 border-blue-100', dot: 'bg-blue-500' },
  LIVE: { label: 'Live', cls: 'bg-green-50 text-green-700 border-green-100', dot: 'bg-green-500' },
  SUSPENDED: { label: 'Suspended', cls: 'bg-red-50 text-red-700 border-red-100', dot: 'bg-red-500' },
  CHURNED: { label: 'Churned', cls: 'bg-surface-container-high text-on-surface-variant border-outline-variant/50', dot: 'bg-outline' },
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
      const out = await TenantApi.transitionLifecycle(reason ? { target, reason } : { target });
      setState(out);
      setReason('');
    } catch (err) {
      showApiError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="glass rounded-xl p-6">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">orbit</span>
          <h2 className="text-h2 font-h2 text-on-surface">Tenant lifecycle</h2>
        </div>
        <p className="mt-2 text-body text-on-surface-variant">
          Apply lifecycle transitions. Going to PILOT or LIVE requires the readiness check to
          pass.
        </p>
      </header>

      <section className="glass space-y-5 rounded-xl p-6">
        {state === null ? (
          <p className="text-body text-on-surface-variant">Loading…</p>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <span className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                Current state
              </span>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-body-sm font-medium ${STATE_LABELS[state.state].cls}`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${STATE_LABELS[state.state].dot}`}
                />
                {STATE_LABELS[state.state].label}
              </span>
            </div>

            {state.allowedTargets.length === 0 ? (
              <p className="text-body-sm text-on-surface-variant">
                No transitions available from this state.
              </p>
            ) : (
              <div className="space-y-4 border-t border-surface-variant/50 pt-4">
                <label className="space-y-1.5">
                  <span className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                    Reason (optional)
                  </span>
                  <input
                    type="text"
                    placeholder="e.g. Sandbox cutover complete"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="glass-input glass-input--sm"
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  {state.allowedTargets.map((t) => (
                    <button
                      key={t}
                      onClick={() => transition(t)}
                      disabled={busy === t}
                      className="btn-outline"
                      style={{ padding: '8px 18px', fontSize: '13px' }}
                    >
                      <span className="material-symbols-outlined text-[18px]">
                        arrow_forward
                      </span>
                      {busy === t ? 'Applying…' : STATE_LABELS[t].label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
