'use client';

import {
  type PasswordPolicyDescriptor,
  type PasswordResetVerifyResponse,
} from '@claims/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { PasswordStrengthMeter } from '../../../../components/password/PasswordStrengthMeter';
import { AuthApi } from '../../../../lib/api/auth.api';

interface PageProps {
  params: { token: string };
}

export default function ResetPasswordPage({ params }: PageProps): JSX.Element {
  const router = useRouter();
  const { showApiError, showError } = useErrorModal();
  const [verified, setVerified] = useState<PasswordResetVerifyResponse | null>(null);
  const [policy, setPolicy] = useState<PasswordPolicyDescriptor | null>(null);
  const [loading, setLoading] = useState(true);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([AuthApi.verifyPasswordReset(params.token), AuthApi.passwordPolicy()])
      .then(([v, pol]) => {
        if (!cancelled) {
          setVerified(v);
          setPolicy(pol);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) showApiError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [params.token, showApiError]);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (password !== confirm) {
      showError('VALIDATION_FAILED', "Passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      await AuthApi.completePasswordReset({ token: params.token, password });
      router.push('/login?reset=ok');
    } catch (err) {
      showApiError(err);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-neutral-500">Verifying link…</p>;
  }
  if (!verified) {
    return (
      <div className="space-y-3 rounded-md bg-neutral-0 p-8 shadow-md">
        <h1 className="text-lg font-semibold text-neutral-800">This link is no longer valid</h1>
        <p className="text-sm text-neutral-600">
          Reset links expire after 30 minutes. Request a new one to continue.
        </p>
        <Link href="/forgot-password" className="text-sm text-primary-600 hover:underline">
          Request new link
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6 rounded-md bg-neutral-0 p-8 shadow-md">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-800">Set a new password</h1>
        <p className="text-sm text-neutral-500">
          {verified.firstName}, choose a new password for your account.
        </p>
        <p className="text-xs text-neutral-400">
          This link expires {new Date(verified.expiresAt).toLocaleString()}.
        </p>
      </header>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="space-y-1">
          <label htmlFor="password" className="text-sm font-medium text-neutral-700">
            New password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none"
          />
          <PasswordStrengthMeter
            password={password}
            policy={policy}
            context={{ email: verified.email, firstName: verified.firstName }}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="confirm" className="text-sm font-medium text-neutral-700">
            Confirm new password
          </label>
          <input
            id="confirm"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none"
          />
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-sm bg-primary-600 px-3 py-2 text-sm font-medium text-neutral-0 hover:bg-primary-700 disabled:opacity-60"
        >
          {submitting ? 'Saving…' : 'Set new password'}
        </button>
      </form>
    </div>
  );
}
