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
    <div className="space-y-4 rounded-md bg-neutral-0 p-8 shadow-md">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-800">Trusted devices</h1>
        <p className="text-sm text-neutral-500">
          Devices that skip the two-step verification challenge for 30 days.
        </p>
      </header>
      {devices === null ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : devices.length === 0 ? (
        <p className="text-sm text-neutral-500">No trusted devices.</p>
      ) : (
        <ul className="space-y-2">
          {devices.map((d) => (
            <li
              key={d.id}
              className="flex items-center justify-between gap-4 rounded-sm border border-neutral-200 p-3"
            >
              <div className="space-y-0.5">
                <p className="text-sm text-neutral-700">
                  {d.userAgent ?? 'Unknown device'}
                  {d.isCurrent ? (
                    <span className="ml-2 rounded-sm bg-success-50 px-2 py-0.5 text-xs text-success-700">
                      this device
                    </span>
                  ) : null}
                </p>
                <p className="text-xs text-neutral-400">
                  {d.ipAddress ?? '—'} · added {new Date(d.createdAt).toLocaleDateString()} ·
                  {d.lastUsedAt ? ` last used ${new Date(d.lastUsedAt).toLocaleString()}` : ' never used'}
                  {' · '}expires {new Date(d.expiresAt).toLocaleDateString()}
                </p>
              </div>
              <button
                onClick={() => revoke(d.id)}
                disabled={busy === d.id}
                className="rounded-sm border border-error-300 px-2 py-1 text-xs text-error-700 hover:bg-error-50 disabled:opacity-60"
              >
                {busy === d.id ? 'Removing…' : 'Remove'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
