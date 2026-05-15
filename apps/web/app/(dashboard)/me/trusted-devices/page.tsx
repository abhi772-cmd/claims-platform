'use client';

import { type TrustedDeviceListItem } from '@claims/contracts';
import { useEffect, useState } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { AuthApi } from '../../../../lib/api/auth.api';

export default function TrustedDevicesPage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const [devices, setDevices] = useState<TrustedDeviceListItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const out = await AuthApi.listTrustedDevices();
      setDevices(out.devices);
    } catch (err) {
      showApiError(err);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function revoke(id: string): Promise<void> {
    setBusy(id);
    try {
      await AuthApi.revokeTrustedDevice(id);
      await load();
    } catch (err) {
      showApiError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <section className="glass space-y-5 rounded-xl p-6">
        <header className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">verified_user</span>
          <div>
            <h2 className="text-h2 font-h2 text-on-surface">Trusted devices</h2>
            <p className="mt-1 text-body-sm text-on-surface-variant">
              Devices that skip the two-step verification challenge for 30 days.
            </p>
          </div>
        </header>
        {devices === null ? (
          <p className="text-body text-on-surface-variant">Loading…</p>
        ) : devices.length === 0 ? (
          <p className="text-body text-on-surface-variant">No trusted devices.</p>
        ) : (
          <ul className="space-y-2">
            {devices.map((d) => (
              <li
                key={d.id}
                className="flex items-center justify-between gap-4 rounded-lg border border-white/40 bg-surface-container-lowest/50 p-4"
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <span className="material-symbols-outlined text-[20px]">smartphone</span>
                  </div>
                  <div className="space-y-1">
                    <p className="flex items-center gap-2 text-body text-on-surface">
                      <span>{d.userAgent ?? 'Unknown device'}</span>
                      {d.isCurrent ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-green-100 bg-green-50 px-2 py-0.5 text-body-sm font-medium text-green-700">
                          <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                          this device
                        </span>
                      ) : null}
                    </p>
                    <p className="text-body-sm text-on-surface-variant">
                      {d.ipAddress ?? '—'} · added {new Date(d.createdAt).toLocaleDateString()} ·
                      {d.lastUsedAt
                        ? ` last used ${new Date(d.lastUsedAt).toLocaleString()}`
                        : ' never used'}
                      {' · '}expires {new Date(d.expiresAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => revoke(d.id)}
                  disabled={busy === d.id}
                  className="inline-flex items-center gap-1.5 rounded-full border border-error/40 px-3 py-1.5 text-body-sm font-semibold text-error transition hover:bg-error/5 disabled:opacity-60"
                >
                  <span className="material-symbols-outlined text-[16px]">delete</span>
                  {busy === d.id ? 'Removing…' : 'Remove'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
