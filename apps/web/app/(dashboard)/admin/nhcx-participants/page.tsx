'use client';

import {
  type NhcxParticipantListItem,
  type RegisterNhcxParticipantRequest,
} from '@claims/contracts';
import { useEffect, useState, type FormEvent } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { NhcxParticipantApi } from '../../../../lib/api/nhcx-participant.api';

// Slice ON-4 — DigiSparsh ops NHCX participant onboarding. Lists every
// tenant with their current participant-registration status. Each row
// expands to a register / re-register form that calls NHA on behalf
// of the tenant.

export default function NhcxParticipantsPage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const [items, setItems] = useState<NhcxParticipantListItem[] | null>(null);
  const [openTenantId, setOpenTenantId] = useState<string | null>(null);

  async function reload(): Promise<void> {
    try {
      const next = await NhcxParticipantApi.list();
      setItems(next.items);
    } catch (err) {
      showApiError(err);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6">
      <header className="glass rounded-xl p-6">
        <h2 className="text-h2 font-h2 text-on-surface">NHCX participant registration</h2>
        <p className="mt-1 max-w-2xl text-body text-on-surface-variant">
          One row per tenant. Click Register to call NHA&apos;s participant API on the
          hospital&apos;s behalf — issues the participant code, confirms the callback URL,
          and auto-completes the hospital&apos;s NHCX onboarding steps.
        </p>
      </header>

      <section className="glass rounded-xl">
        {items === null ? (
          <p className="p-6 text-body text-on-surface-variant">Loading tenants…</p>
        ) : items.length === 0 ? (
          <p className="p-6 text-body text-on-surface-variant">No tenants yet.</p>
        ) : (
          <ul className="divide-y divide-outline-variant/30">
            {items.map((it) => (
              <li key={it.tenantId} className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-on-surface">{it.tenantDisplayName}</p>
                    <p className="text-body-sm text-on-surface-variant">{it.tenantSlug}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusPill config={it.config} />
                    <button
                      type="button"
                      onClick={() =>
                        setOpenTenantId((cur) => (cur === it.tenantId ? null : it.tenantId))
                      }
                      className="btn-outline inline-flex items-center"
                      style={{ padding: '6px 14px', fontSize: '12px' }}
                    >
                      <span className="material-symbols-outlined text-[16px]">
                        {openTenantId === it.tenantId ? 'expand_less' : 'expand_more'}
                      </span>
                      {it.config?.participantCode ? 'Re-register' : 'Register'}
                    </button>
                  </div>
                </div>
                {openTenantId === it.tenantId && (
                  <RegisterPanel
                    item={it}
                    onDone={async () => {
                      setOpenTenantId(null);
                      await reload();
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function StatusPill({
  config,
}: {
  config: NhcxParticipantListItem['config'];
}): JSX.Element {
  if (!config) {
    return (
      <span className="inline-flex items-center rounded-full border border-amber-100 bg-amber-50 px-2 py-0.5 text-body-sm font-medium text-amber-700">
        Not registered
      </span>
    );
  }
  if (config.lastError) {
    return (
      <span
        title={config.lastError}
        className="inline-flex items-center rounded-full border border-red-100 bg-red-50 px-2 py-0.5 text-body-sm font-medium text-red-700"
      >
        Last attempt failed
      </span>
    );
  }
  if (config.participantCode) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-green-100 bg-green-50 px-2 py-0.5 text-body-sm font-medium text-green-700">
        <span
          className="material-symbols-outlined text-[14px]"
          style={{ fontVariationSettings: "'FILL' 1" }}
        >
          check_circle
        </span>
        {config.participantCode}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border border-blue-100 bg-blue-50 px-2 py-0.5 text-body-sm font-medium text-blue-700">
      Awaiting response
    </span>
  );
}

function RegisterPanel({
  item,
  onDone,
}: {
  item: NhcxParticipantListItem;
  onDone: () => Promise<void>;
}): JSX.Element {
  const { showApiError } = useErrorModal();
  const [hfrFacilityId, setHfrFacilityId] = useState(item.config?.hfrFacilityId ?? '');
  const [callbackUrl, setCallbackUrl] = useState(
    item.config?.callbackUrl ?? defaultCallbackUrl(item.tenantId),
  );
  const [sandboxMode, setSandboxMode] = useState(item.config?.sandboxMode ?? true);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    try {
      const body: RegisterNhcxParticipantRequest = {
        hfrFacilityId: hfrFacilityId.trim(),
        callbackUrl: callbackUrl.trim(),
        sandboxMode,
      };
      await NhcxParticipantApi.register(item.tenantId, body);
      await onDone();
    } catch (err) {
      showApiError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
      <label className="block space-y-1.5">
        <span className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
          HFR facility ID
        </span>
        <input
          type="text"
          value={hfrFacilityId}
          onChange={(e) => setHfrFacilityId(e.target.value)}
          required
          minLength={6}
          maxLength={64}
          className="glass-input glass-input--sm font-mono"
        />
      </label>
      <label className="block space-y-1.5">
        <span className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
          Callback URL
        </span>
        <input
          type="url"
          value={callbackUrl}
          onChange={(e) => setCallbackUrl(e.target.value)}
          required
          pattern="https://.*"
          className="glass-input glass-input--sm font-mono"
        />
      </label>
      <label className="col-span-1 flex items-center gap-2 text-body-sm text-on-surface sm:col-span-2">
        <input
          type="checkbox"
          checked={sandboxMode}
          onChange={(e) => setSandboxMode(e.target.checked)}
          className="h-4 w-4 accent-primary"
        />
        Register against NHA sandbox (uncheck for production gateway — production lifecycle
        only)
      </label>
      <div className="col-span-1 flex justify-end sm:col-span-2">
        <button
          type="submit"
          disabled={submitting}
          className="btn-primary inline-flex items-center"
          style={{ padding: '8px 16px', fontSize: '13px' }}
        >
          <span
            className="material-symbols-outlined text-[18px]"
            style={{ fontVariationSettings: "'FILL' 1" }}
          >
            send
          </span>
          {submitting ? 'Calling NHA…' : 'Submit registration'}
        </button>
      </div>
    </form>
  );
}

function defaultCallbackUrl(tenantId: string): string {
  if (typeof window === 'undefined') return '';
  // Suggested default for the form. Ops can override before submit;
  // the value the form sends is what gets registered with NHA.
  const origin = window.location.origin;
  return `${origin}/api/nhcx/callback/${tenantId}/on_request`;
}
