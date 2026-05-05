'use client';

import { type SessionListItem } from '@claims/contracts';
import { useEffect, useState } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { AuthApi } from '../../../../lib/api/auth.api';

export default function SessionsPage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const out = await AuthApi.listSessions();
      setSessions(out.sessions);
    } catch (err) {
      showApiError(err);
    }
  }

  useEffect(() => {
    void load();
    // load is stable in this component (no closures over state) — only run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function revoke(id: string): Promise<void> {
    setBusy(id);
    try {
      await AuthApi.revokeSession(id);
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
        <h1 className="text-xl font-semibold text-neutral-800">Active sessions</h1>
        <p className="text-sm text-neutral-500">
          Devices currently signed in to your account.
        </p>
      </header>
      {sessions === null ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-neutral-500">No active sessions.</p>
      ) : (
        <ul className="space-y-2">
          {sessions.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-4 rounded-sm border border-neutral-200 p-3"
            >
              <div className="space-y-0.5">
                <p className="text-sm text-neutral-700">
                  {s.userAgent ?? 'Unknown device'}
                  {s.isCurrent ? (
                    <span className="ml-2 rounded-sm bg-success-50 px-2 py-0.5 text-xs text-success-700">
                      this device
                    </span>
                  ) : null}
                </p>
                <p className="text-xs text-neutral-400">
                  {s.ipAddress ?? '—'} · started {new Date(s.createdAt).toLocaleString()} · expires{' '}
                  {new Date(s.expiresAt).toLocaleDateString()}
                </p>
              </div>
              {s.isCurrent ? (
                <span className="text-xs text-neutral-400">use sign-out to end</span>
              ) : (
                <button
                  onClick={() => revoke(s.id)}
                  disabled={busy === s.id}
                  className="rounded-sm border border-error-300 px-2 py-1 text-xs text-error-700 hover:bg-error-50 disabled:opacity-60"
                >
                  {busy === s.id ? 'Revoking…' : 'Revoke'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
