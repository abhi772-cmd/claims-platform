'use client';

import {
  type PasswordPolicyDescriptor,
  type PasswordResetVerifyResponse,
} from '@claims/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { AuthCard } from '../../../../components/auth/AuthCard';
import { AuthField } from '../../../../components/auth/AuthField';
import { AuthSubmit } from '../../../../components/auth/AuthSubmit';
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
    return (
      <AuthCard icon="hourglass_top" eyebrow="Account recovery" title="Verifying link…">
        <p className="text-center text-body text-on-surface-variant">
          One moment while we check your reset link.
        </p>
      </AuthCard>
    );
  }
  if (!verified) {
    return (
      <AuthCard
        icon="link_off"
        tone="warning"
        eyebrow="Account recovery"
        title="This link is no longer valid"
      >
        <p className="text-center text-body text-on-surface">
          Reset links expire after 30 minutes. Request a new one to continue.
        </p>
        <div className="mt-6 text-center">
          <Link
            href="/forgot-password"
            className="text-body-sm font-medium text-primary transition-colors hover:text-primary-container"
          >
            Request a new link →
          </Link>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      icon="password"
      eyebrow="Account recovery"
      title="Choose a new password"
      subtitle={`${verified.firstName}, set a new password for your account.`}
    >
      <p className="-mt-4 mb-6 text-center text-body-sm text-on-surface-variant opacity-80">
        This link expires {new Date(verified.expiresAt).toLocaleString()}.
      </p>
      <form onSubmit={onSubmit} className="space-y-6" noValidate>
        <div className="space-y-2">
          <AuthField
            label="New password"
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
            context={{ email: verified.email, firstName: verified.firstName }}
          />
        </div>
        <AuthField
          label="Confirm new password"
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
            label="Set new password"
            submitting={submitting}
            loadingLabel="Saving…"
          />
        </div>
      </form>
    </AuthCard>
  );
}
