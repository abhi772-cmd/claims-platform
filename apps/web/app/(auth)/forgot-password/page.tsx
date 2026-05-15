'use client';

import { PasswordResetInitiateRequestSchema } from '@claims/contracts';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';

import { AuthCard } from '../../../components/auth/AuthCard';
import { AuthField } from '../../../components/auth/AuthField';
import { AuthSubmit } from '../../../components/auth/AuthSubmit';
import { useErrorModal } from '../../../components/modals/ErrorModal/ErrorModalProvider';
import { AuthApi } from '../../../lib/api/auth.api';

export default function ForgotPasswordPage(): JSX.Element {
  const { showApiError, showError } = useErrorModal();
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const parsed = PasswordResetInitiateRequestSchema.safeParse({ email });
    if (!parsed.success) {
      showError('VALIDATION_FAILED', parsed.error.issues[0]?.message);
      return;
    }
    setSubmitting(true);
    try {
      await AuthApi.initiatePasswordReset(parsed.data);
      setDone(true);
    } catch (err) {
      showApiError(err);
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <AuthCard
        icon="mark_email_read"
        tone="success"
        eyebrow="Account recovery"
        title="Check your inbox"
      >
        <div className="space-y-3 text-center text-body text-on-surface">
          <p>
            If an account exists for{' '}
            <span className="font-medium text-on-surface">{email}</span>, we&apos;ve sent a
            password reset link. It expires in 30 minutes.
          </p>
          <p className="text-body-sm text-on-surface-variant">
            Didn&apos;t get it? Check your spam folder, or wait a moment and try again.
          </p>
        </div>
        <div className="mt-6 text-center">
          <Link
            href="/login"
            className="text-body-sm font-medium text-primary transition-colors hover:text-primary-container"
          >
            ← Back to sign in
          </Link>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      icon="lock_reset"
      eyebrow="Account recovery"
      title="Reset your password"
      subtitle="Enter your work email and we'll send you a secure reset link."
    >
      <form onSubmit={onSubmit} className="space-y-6" noValidate>
        <AuthField
          label="Work email"
          icon="mail"
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@hospital.in"
        />

        <div className="pt-2">
          <AuthSubmit label="Send reset link" submitting={submitting} loadingLabel="Sending…" />
        </div>

        <div className="text-center">
          <Link
            href="/login"
            className="text-body-sm font-medium text-primary transition-colors hover:text-primary-container"
          >
            ← Back to sign in
          </Link>
        </div>

        <div className="pt-2 text-center text-body-sm text-on-surface-variant opacity-80">
          Processed under DPDP Act 2023 §6.
        </div>
      </form>
    </AuthCard>
  );
}
