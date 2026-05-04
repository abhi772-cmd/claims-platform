'use client';

import { type InvitePreview } from '@claims/contracts';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { apiRequest } from '../../../../lib/api/client';

interface PageProps {
  params: { token: string };
}

export default function AcceptInvitePage({ params }: PageProps): JSX.Element {
  const router = useRouter();
  const { showApiError, showError } = useErrorModal();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiRequest<InvitePreview>(`/auth/invite/${encodeURIComponent(params.token)}`)
      .then((p) => {
        if (!cancelled) setPreview(p);
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
    if (password.length < 12) {
      showError('AUTH_PASSWORD_TOO_WEAK', 'Password must be at least 12 characters.');
      return;
    }
    if (password !== confirm) {
      showError('VALIDATION_FAILED', "Passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      await apiRequest<void>('/auth/accept-invite', {
        method: 'POST',
        body: { token: params.token, password },
      });
      router.push('/login');
    } catch (err) {
      showApiError(err);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-neutral-500">Loading invite…</p>;
  }
  if (!preview) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-danger-700">This invite is not valid.</p>
        <p className="text-sm text-neutral-500">Ask your admin to send a new one.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 rounded-md bg-neutral-0 p-8 shadow-md">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-800">Accept your invite</h1>
        <p className="text-sm text-neutral-500">
          {preview.firstName}, you&apos;ve been invited to {preview.tenantDisplayName}.
        </p>
        <p className="text-xs text-neutral-400">
          Expires {new Date(preview.expiresAt).toLocaleString()}
        </p>
      </header>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="space-y-1">
          <label htmlFor="password" className="text-sm font-medium text-neutral-700">
            Choose a password
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
          <p className="text-xs text-neutral-400">
            Min 12 chars, with lowercase, uppercase, digit, and symbol.
          </p>
        </div>
        <div className="space-y-1">
          <label htmlFor="confirm" className="text-sm font-medium text-neutral-700">
            Confirm password
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
          {submitting ? 'Setting up…' : 'Accept invite'}
        </button>
      </form>
    </div>
  );
}
