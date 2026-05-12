'use client';

import { type InvitePreview, type PasswordPolicyDescriptor } from '@claims/contracts';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { AuthCard } from '../../../../components/auth/AuthCard';
import { AuthField } from '../../../../components/auth/AuthField';
import { AuthSubmit } from '../../../../components/auth/AuthSubmit';
import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { PasswordStrengthMeter } from '../../../../components/password/PasswordStrengthMeter';
import { AuthApi } from '../../../../lib/api/auth.api';
import { apiRequest } from '../../../../lib/api/client';

interface PageProps {
  params: { token: string };
}

export default function AcceptInvitePage({ params }: PageProps): JSX.Element {
  const router = useRouter();
  const { showApiError, showError } = useErrorModal();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [policy, setPolicy] = useState<PasswordPolicyDescriptor | null>(null);
  const [loading, setLoading] = useState(true);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiRequest<InvitePreview>(`/auth/invite/${encodeURIComponent(params.token)}`),
      AuthApi.passwordPolicy(),
    ])
      .then(([p, pol]) => {
        if (!cancelled) {
          setPreview(p);
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
    return (
      <AuthCard icon="hourglass_top" eyebrow="You're invited" title="Loading your invite…">
        <p className="text-center text-body text-on-surface-variant">One moment.</p>
      </AuthCard>
    );
  }
  if (!preview) {
    return (
      <AuthCard
        icon="link_off"
        tone="danger"
        eyebrow="You're invited"
        title="This invite is not valid"
      >
        <p className="text-center text-body text-on-surface">
          Invite links expire after a short window. Ask your admin to send a new one.
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      icon="person_add"
      eyebrow="You're invited"
      title="Set up your account"
      subtitle={`${preview.firstName}, you've been invited to join ${preview.tenantDisplayName}.`}
    >
      <div className="-mt-4 mb-6 flex flex-wrap items-center justify-center gap-2">
        <span className="rounded-full bg-surface-container-low px-3 py-1 text-body-sm font-medium text-on-surface-variant ring-1 ring-outline-variant">
          {preview.email}
        </span>
        <span className="rounded-full bg-primary-container/10 px-3 py-1 text-body-sm font-medium text-primary-container ring-1 ring-primary-container/30">
          {preview.tenantDisplayName}
        </span>
      </div>
      <p className="-mt-2 mb-6 text-center text-body-sm text-on-surface-variant opacity-80">
        Expires {new Date(preview.expiresAt).toLocaleString()}.
      </p>

      <form onSubmit={onSubmit} className="space-y-6" noValidate>
        <div className="space-y-2">
          <AuthField
            label="Create a password"
            icon="lock"
            password
            id="password"
            autoComplete="new-password"
            required
            minLength={12}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••••••"
          />
          <PasswordStrengthMeter
            password={password}
            policy={policy}
            context={{
              email: preview.email,
              firstName: preview.firstName,
              lastName: preview.lastName,
            }}
          />
        </div>
        <AuthField
          label="Confirm password"
          icon="lock"
          password
          id="confirm"
          autoComplete="new-password"
          required
          minLength={12}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="••••••••••••"
        />
        <div className="pt-2">
          <AuthSubmit
            label="Activate account"
            submitting={submitting}
            loadingLabel="Setting up…"
          />
        </div>
      </form>
    </AuthCard>
  );
}
