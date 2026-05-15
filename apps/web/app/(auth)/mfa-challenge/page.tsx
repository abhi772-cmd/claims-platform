'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';

import { AuthCard } from '../../../components/auth/AuthCard';
import { AuthField } from '../../../components/auth/AuthField';
import { AuthSubmit } from '../../../components/auth/AuthSubmit';
import { useErrorModal } from '../../../components/modals/ErrorModal/ErrorModalProvider';
import { AuthApi } from '../../../lib/api/auth.api';

function MfaChallengeForm(): JSX.Element {
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
    <form onSubmit={onSubmit} className="space-y-6" noValidate>
      <AuthField
        label="Verification code"
        icon="pin"
        id="code"
        name="code"
        type="text"
        inputMode="text"
        autoComplete="one-time-code"
        autoFocus
        required
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="123456 or backup code"
        centered
      />

      <label className="ml-1 flex items-center gap-2 text-body-sm text-on-surface-variant">
        <input
          type="checkbox"
          checked={trustDevice}
          onChange={(e) => setTrustDevice(e.target.checked)}
          className="h-4 w-4 rounded border-outline-variant accent-primary"
        />
        Remember this device for 30 days
      </label>

      <div className="pt-2">
        <AuthSubmit
          label="Verify"
          submitting={submitting}
          loadingLabel="Verifying…"
          disabled={code.length === 0}
        />
      </div>

      <div className="text-center">
        <Link
          href="/login"
          className="text-body-sm font-medium text-primary transition-colors hover:text-primary-container"
        >
          ← Back to sign in
        </Link>
      </div>
    </form>
  );
}

export default function MfaChallengePage(): JSX.Element {
  return (
    <AuthCard
      icon="encrypted"
      eyebrow="Security check"
      title="Two-step verification"
      subtitle="Enter the 6-digit code from your authenticator app, or one of your backup codes."
    >
      <Suspense
        fallback={<p className="mt-6 text-body-sm text-on-surface-variant">Loading…</p>}
      >
        <MfaChallengeForm />
      </Suspense>
    </AuthCard>
  );
}
