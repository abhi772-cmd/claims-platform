'use client';

import { type SessionListItem } from '@claims/contracts';
import { useEffect, useState } from 'react';

import { useConfirm } from '../../../../components/modals/ConfirmDialog/ConfirmDialogProvider';
import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { useToast } from '../../../../components/toast/ToastProvider';
import { AuthApi } from '../../../../lib/api/auth.api';

export default function SessionsPage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const confirm = useConfirm();
  const showToast = useToast();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function revoke(id: string): Promise<void> {
    const target = sessions?.find((s) => s.id === id);
    const label = target?.userAgent ?? 'this device';
    const ok = await confirm({
      title: 'Revoke this session?',
      body: (
        <>
          <span className="font-semibold">{label}</span> will be signed out
          immediately. If the device tries to make a request afterwards it
          will be redirected to the login screen.
        </>
      ),
      tone: 'warning',
      confirmLabel: 'Revoke session',
    });
    if (!ok) return;
    setBusy(id);
    try {
      await AuthApi.revokeSession(id);
      showToast({ tone: 'success', message: 'Session revoked.' });
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
          <span className="material-symbols-outlined text-primary">devices</span>
          <div>
            <h2 className="text-h2 font-h2 text-on-surface">Active sessions</h2>
            <p className="mt-1 text-body-sm text-on-surface-variant">
              Devices currently signed in to your account.
            </p>
          </div>
        </header>
        {sessions === null ? (
          <p className="text-body text-on-surface-variant">Loading…</p>
        ) : sessions.length === 0 ? (
          <p className="text-body text-on-surface-variant">No active sessions.</p>
        ) : (
          <ul className="space-y-2">
            {sessions.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-4 rounded-lg border border-white/40 bg-surface-container-lowest/50 p-4"
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <span className="material-symbols-outlined text-[20px]">computer</span>
                  </div>
                  <div className="space-y-1">
                    <p className="flex items-center gap-2 text-body text-on-surface">
                      <span>{s.userAgent ?? 'Unknown device'}</span>
                      {s.isCurrent ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-green-100 bg-green-50 px-2 py-0.5 text-body-sm font-medium text-green-700">
                          <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                          this device
                        </span>
                      ) : null}
                    </p>
                    <p className="text-body-sm text-on-surface-variant">
                      {s.ipAddress ?? '—'} · started {new Date(s.createdAt).toLocaleString()} ·
                      expires {new Date(s.expiresAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                {s.isCurrent ? (
                  <span className="text-body-sm text-on-surface-variant">use sign-out to end</span>
                ) : (
                  <button
                    onClick={() => revoke(s.id)}
                    disabled={busy === s.id}
                    className="inline-flex items-center gap-1.5 rounded-full border border-error/40 px-3 py-1.5 text-body-sm font-semibold text-error transition hover:bg-error/5 disabled:opacity-60"
                  >
                    <span className="material-symbols-outlined text-[16px]">logout</span>
                    {busy === s.id ? 'Revoking…' : 'Revoke'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
