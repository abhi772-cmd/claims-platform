'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { useErrorModal } from '../../../components/modals/ErrorModal/ErrorModalProvider';
import { AuthApi } from '../../../lib/api/auth.api';

export default function MfaChallengePage(): JSX.Element {
  const router = useRouter();
  const params = useSearchParams();
  const challengeId = params.get('challenge') ?? '';
  const { showApiError, showError } = useErrorModal();
  const [code, setCode] = useState('');
  const [trustDevice, setTrustDevice] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!challengeId) {
      showError('AUTH_MFA_CHALLENGE_INVALID');
      router.push('/login');
      return;
    }
    setSubmitting(true);
    try {
      await AuthApi.mfaVerify({ challengeId, code, trustDevice });
      router.push('/dashboard');
    } catch (err) {
      showApiError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6 rounded-md bg-neutral-0 p-8 shadow-md">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-800">Two-step verification</h1>
        <p className="text-sm text-neutral-500">
          Enter the 6-digit code from your authenticator app, or one of your backup codes.
        </p>
      </header>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="space-y-1">
          <label htmlFor="code" className="text-sm font-medium text-neutral-700">
            Verification code
          </label>
          <input
            id="code"
            name="code"
            type="text"
            inputMode="text"
            autoComplete="one-time-code"
            autoFocus
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 text-sm font-mono tracking-wider focus:border-primary-500 focus:outline-none"
            placeholder="123456 or XXXX-XXXX-XXXX"
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-neutral-600">
          <input
            type="checkbox"
            checked={trustDevice}
            onChange={(e) => setTrustDevice(e.target.checked)}
            className="rounded-sm border-neutral-300"
          />
          Trust this device for 30 days
        </label>
        <button
          type="submit"
          disabled={submitting || code.length === 0}
          className="w-full rounded-sm bg-primary-600 px-3 py-2 text-sm font-medium text-neutral-0 hover:bg-primary-700 disabled:opacity-60"
        >
          {submitting ? 'Verifying…' : 'Verify'}
        </button>
      </form>
    </div>
  );
}
