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

  if (!me) return <p className="text-sm text-neutral-500">Loading…</p>;

  return (
    <div className="space-y-6 rounded-md bg-neutral-0 p-8 shadow-md">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-800">Two-step verification</h1>
        <p className="text-sm text-neutral-500">
          Add a second factor on top of your password. Required for some roles by your admin.
        </p>
      </header>

      {backupCodes ? (
        <div className="space-y-3 rounded-sm border border-warning-300 bg-warning-50 p-4">
          <p className="text-sm font-medium text-warning-700">Save these backup codes</p>
          <p className="text-xs text-warning-700">
            Each code can be used once if you lose access to your authenticator. We won&apos;t
            show them again.
          </p>
          <ul className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm text-neutral-800">
            {backupCodes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <button
            onClick={() => setBackupCodes(null)}
            className="rounded-sm bg-primary-600 px-3 py-1 text-xs font-medium text-neutral-0"
          >
            I&apos;ve saved them
          </button>
        </div>
      ) : null}

      {mode === 'idle' && !setup ? (
        <button
          onClick={startSetup}
          disabled={submitting}
          className="rounded-sm bg-primary-600 px-3 py-2 text-sm font-medium text-neutral-0 hover:bg-primary-700 disabled:opacity-60"
        >
          {submitting ? 'Starting…' : 'Set up two-step verification'}
        </button>
      ) : null}

      {mode === 'setup-pending' && setup ? (
        <div className="space-y-4">
          <p className="text-sm text-neutral-600">
            Scan this QR with your authenticator app, or enter the code below manually.
          </p>
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={setup.qrDataUrl} alt="MFA QR code" className="h-40 w-40 rounded-sm border border-neutral-200" />
            <div className="space-y-1">
              <p className="text-xs text-neutral-500">Manual setup key</p>
              <p className="font-mono text-xs break-all text-neutral-700">{setup.secret}</p>
            </div>
          </div>
          <form onSubmit={confirm} className="space-y-2">
            <label htmlFor="code" className="text-sm font-medium text-neutral-700">
              Enter the 6-digit code from your app
            </label>
            <input
              id="code"
              type="text"
              inputMode="numeric"
              pattern="[0-9]{6}"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="w-40 rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 font-mono tracking-wider"
            />
            <button
              type="submit"
              disabled={submitting || !/^[0-9]{6}$/.test(code)}
              className="ml-2 rounded-sm bg-primary-600 px-3 py-2 text-sm font-medium text-neutral-0 hover:bg-primary-700 disabled:opacity-60"
            >
              {submitting ? 'Confirming…' : 'Confirm'}
            </button>
          </form>
        </div>
      ) : null}

      {mode === 'confirmed' && !backupCodes ? (
        <div className="space-y-3 rounded-sm border border-success-200 bg-success-50 p-4">
          <p className="text-sm font-medium text-success-700">Two-step verification is on.</p>
          <button
            onClick={() => setMode('disabling')}
            className="text-xs text-error-700 hover:underline"
          >
            Disable two-step verification
          </button>
        </div>
      ) : null}

      {mode === 'disabling' ? (
        <form onSubmit={disable} className="space-y-3 rounded-sm border border-neutral-200 p-4">
          <p className="text-sm font-medium text-neutral-800">
            Confirm your password and one current code to disable.
          </p>
          <input
            type="password"
            placeholder="Current password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
            className="w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 text-sm"
          />
          <input
            type="text"
            placeholder="Authenticator code or backup code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            className="w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 font-mono text-sm"
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={submitting}
              className="rounded-sm bg-error-600 px-3 py-2 text-sm font-medium text-neutral-0 hover:bg-error-700 disabled:opacity-60"
            >
              {submitting ? 'Disabling…' : 'Disable'}
            </button>
            <button
              type="button"
              onClick={() => setMode('confirmed')}
              className="rounded-sm border border-neutral-200 px-3 py-2 text-sm"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
