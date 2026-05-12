'use client';

import { LoginRequestSchema } from '@claims/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { AuthCard } from '../../../components/auth/AuthCard';
import { AuthField } from '../../../components/auth/AuthField';
import { AuthSubmit } from '../../../components/auth/AuthSubmit';
import { useErrorModal } from '../../../components/modals/ErrorModal/ErrorModalProvider';
import { AuthApi } from '../../../lib/api/auth.api';

export default function LoginPage(): JSX.Element {
  const router = useRouter();
  const { showApiError, showError } = useErrorModal();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const parsed = LoginRequestSchema.safeParse({ email, password });
    if (!parsed.success) {
      showError('VALIDATION_FAILED', parsed.error.issues[0]?.message);
      return;
    }
    setSubmitting(true);
    try {
      const result = await AuthApi.login(parsed.data);
      if ('mfaRequired' in result && result.mfaRequired) {
        const params = new URLSearchParams({
          challenge: result.challengeId,
          expires: result.expiresAt,
        });
        router.push(`/mfa-challenge?${params.toString()}`);
        return;
      }
      router.push('/dashboard');
    } catch (err) {
      showApiError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCard
      icon="login"
      title="Welcome back"
      subtitle="Sign in to manage hospital claims"
    >
      <form onSubmit={onSubmit} className="space-y-6" noValidate>
        <AuthField
          label="Work Email"
          icon="mail"
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="dr.smith@hospital.com"
        />
        <AuthField
          label="Password"
          icon="lock"
          password
          id="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          labelAside={
            <Link
              href="/forgot-password"
              className="text-body-sm font-medium text-primary transition-colors hover:text-primary-container"
            >
              Forgot password?
            </Link>
          }
        />

        <div className="pt-4">
          <AuthSubmit label="Sign in" submitting={submitting} loadingLabel="Signing in…" />
        </div>
      </form>

      <div className="mt-8 border-t border-surface-dim/30 pt-6 text-center">
        <p className="flex items-center justify-center gap-1.5 text-body-sm text-on-surface-variant opacity-80">
          <span className="material-symbols-outlined text-[16px]">admin_panel_settings</span>
          Secured under DPDP Act compliance.
        </p>
      </div>
    </AuthCard>
  );
}
