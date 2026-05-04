'use client';

import { PasswordResetInitiateRequestSchema } from '@claims/contracts';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';

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
      <div className="space-y-4 rounded-md bg-neutral-0 p-8 shadow-md">
        <h1 className="text-xl font-semibold text-neutral-800">Check your email</h1>
        <p className="text-sm text-neutral-600">
          If an account exists for <span className="font-medium">{email}</span>, we&apos;ve
          sent a password reset link. The link expires in 30 minutes.
        </p>
        <p className="text-xs text-neutral-500">
          Didn&apos;t get it? Check your spam folder, or wait a moment and try again.
        </p>
        <Link href="/login" className="text-sm text-primary-600 hover:underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6 rounded-md bg-neutral-0 p-8 shadow-md">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-800">Reset your password</h1>
        <p className="text-sm text-neutral-500">
          Enter your email and we&apos;ll send you a link to set a new password.
        </p>
      </header>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="space-y-1">
          <label htmlFor="email" className="text-sm font-medium text-neutral-700">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none"
          />
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-sm bg-primary-600 px-3 py-2 text-sm font-medium text-neutral-0 hover:bg-primary-700 disabled:opacity-60"
        >
          {submitting ? 'Sending…' : 'Send reset link'}
        </button>
        <div className="text-center">
          <Link href="/login" className="text-xs text-primary-600 hover:underline">
            Back to sign in
          </Link>
        </div>
      </form>
    </div>
  );
}
