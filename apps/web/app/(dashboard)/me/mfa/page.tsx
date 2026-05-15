'use client';

import { type MeResponse, type MfaSetupResponse } from '@claims/contracts';
import { useEffect, useState, type FormEvent } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { AuthApi } from '../../../../lib/api/auth.api';

type Mode = 'idle' | 'setup-pending' | 'confirmed' | 'disabling';

export default function MfaPage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [mode, setMode] = useState<Mode>('idle');
  const [setup, setSetup] = useState<MfaSetupResponse | null>(null);
  const [code, setCode] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AuthApi.me()
      .then((m) => {
        if (!cancelled) setMe(m);
      })
      .catch((err: unknown) => {
        if (!cancelled) showApiError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [showApiError]);

  async function startSetup(): Promise<void> {
    setSubmitting(true);
    try {
      const out = await AuthApi.mfaSetup();
      setSetup(out);
      setMode('setup-pending');
    } catch (err) {
      showApiError(err);
    } finally {
      setSubmitting(false);
    }
  }

  async function confirm(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    try {
      const out = await AuthApi.mfaConfirm({ code });
      setBackupCodes(out.backupCodes);
      setMode('confirmed');
      setCode('');
    } catch (err) {
      showApiError(err);
    } finally {
      setSubmitting(false);
    }
  }

  async function disable(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    try {
      await AuthApi.mfaDisable({ currentPassword, code });
      setMode('idle');
      setCurrentPassword('');
      setCode('');
      setBackupCodes(null);
      setSetup(null);
    } catch (err) {
      showApiError(err);
    } finally {
      setSubmitting(false);
    }
  }

  if (!me) return <p className="text-body text-on-surface-variant">Loading…</p>;

  return (
    <div className="mx-auto w-full max-w-2xl">
      <section className="glass space-y-6 rounded-xl p-8">
        <header className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">encrypted</span>
          <div>
            <h2 className="text-h2 font-h2 text-on-surface">Two-step verification</h2>
            <p className="mt-1 text-body-sm text-on-surface-variant">
              Add a second factor on top of your password. Required for some roles by your
              admin.
            </p>
          </div>
        </header>

        {backupCodes ? (
          <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-5">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-amber-700">key</span>
              <p className="text-body font-semibold text-amber-700">Save these backup codes</p>
            </div>
            <p className="text-body-sm text-amber-700">
              Each code can be used once if you lose access to your authenticator. We won&apos;t
              show them again.
            </p>
            <ul className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-body text-on-surface">
              {backupCodes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <button
              onClick={() => setBackupCodes(null)}
              className="btn-primary"
              style={{ padding: '8px 18px', fontSize: '13px' }}
            >
              <span className="material-symbols-outlined text-[18px]">check_circle</span>
              I&apos;ve saved them
            </button>
          </div>
        ) : null}

        {mode === 'idle' && !setup ? (
          <button
            onClick={startSetup}
            disabled={submitting}
            className="btn-primary"
            style={{ padding: '12px 24px', fontSize: '13px' }}
          >
            <span
              className="material-symbols-outlined text-[18px]"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              add_circle
            </span>
            {submitting ? 'Starting…' : 'Set up two-step verification'}
          </button>
        ) : null}

        {mode === 'setup-pending' && setup ? (
          <div className="space-y-4">
            <p className="text-body text-on-surface">
              Scan this QR with your authenticator app, or enter the code below manually.
            </p>
            <div className="flex flex-col items-start gap-4 rounded-xl border border-white/40 bg-surface-container-lowest/50 p-5 sm:flex-row sm:items-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={setup.qrDataUrl}
                alt="MFA QR code"
                className="h-40 w-40 rounded-lg border border-outline-variant/40 bg-white p-2"
              />
              <div className="space-y-1">
                <p className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                  Manual setup key
                </p>
                <p className="break-all font-mono text-body-sm text-on-surface">
                  {setup.secret}
                </p>
              </div>
            </div>
            <form onSubmit={confirm} className="space-y-2">
              <label
                htmlFor="code"
                className="block text-eyebrow uppercase tracking-eyebrow text-on-surface-variant"
              >
                Enter the 6-digit code from your app
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="code"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="glass-input glass-input--sm w-44 text-center font-mono tabular-nums tracking-wider"
                />
                <button
                  type="submit"
                  disabled={submitting || !/^[0-9]{6}$/.test(code)}
                  className="btn-primary"
                  style={{ padding: '10px 22px', fontSize: '13px' }}
                >
                  <span className="material-symbols-outlined text-[18px]">check_circle</span>
                  {submitting ? 'Confirming…' : 'Confirm'}
                </button>
              </div>
            </form>
          </div>
        ) : null}

        {mode === 'confirmed' && !backupCodes ? (
          <div className="space-y-3 rounded-xl border border-green-200 bg-green-50 p-5">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-green-700">verified_user</span>
              <p className="text-body font-semibold text-green-700">
                Two-step verification is on.
              </p>
            </div>
            <button
              onClick={() => setMode('disabling')}
              className="text-body-sm font-medium text-error hover:underline"
            >
              Disable two-step verification
            </button>
          </div>
        ) : null}

        {mode === 'disabling' ? (
          <form
            onSubmit={disable}
            className="space-y-3 rounded-xl border border-white/40 bg-surface-container-lowest/50 p-5"
          >
            <p className="text-body font-semibold text-on-surface">
              Confirm your password and one current code to disable.
            </p>
            <input
              type="password"
              placeholder="Current password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              className="glass-input glass-input--sm"
            />
            <input
              type="text"
              placeholder="Authenticator code or backup code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              className="glass-input glass-input--sm font-mono"
            />
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex items-center gap-2 rounded-full bg-error px-5 py-2.5 text-body-sm font-semibold text-on-error shadow-[0_4px_14px_rgba(186,26,26,0.25)] transition hover:bg-[#93000a] disabled:opacity-60"
              >
                <span className="material-symbols-outlined text-[18px]">remove_circle</span>
                {submitting ? 'Disabling…' : 'Disable'}
              </button>
              <button
                type="button"
                onClick={() => setMode('confirmed')}
                className="btn-outline"
                style={{ padding: '10px 22px', fontSize: '13px' }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}
      </section>
    </div>
  );
}
