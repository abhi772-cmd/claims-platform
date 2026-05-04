'use client';

import { type MeResponse, type PasswordPolicyDescriptor } from '@claims/contracts';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { PasswordStrengthMeter } from '../../../../components/password/PasswordStrengthMeter';
import { AuthApi } from '../../../../lib/api/auth.api';

export default function ChangePasswordPage(): JSX.Element {
  const { showApiError, showError } = useErrorModal();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [policy, setPolicy] = useState<PasswordPolicyDescriptor | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([AuthApi.me(), AuthApi.passwordPolicy()])
      .then(([m, pol]) => {
        if (!cancelled) {
          setMe(m);
          setPolicy(pol);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) showApiError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [showApiError]);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (newPassword !== confirm) {
      showError('VALIDATION_FAILED', "New passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      await AuthApi.changePassword({ currentPassword, newPassword });
      setDone(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
    } catch (err) {
      showApiError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6 rounded-md bg-neutral-0 p-8 shadow-md">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-800">Change your password</h1>
        <p className="text-sm text-neutral-500">
          Confirm your current password, then choose a new one.
        </p>
      </header>
      {done ? (
        <div className="space-y-2 rounded-sm border border-success-200 bg-success-50 p-4">
          <p className="text-sm font-medium text-success-700">Password updated.</p>
          <p className="text-xs text-success-700">
            Use your new password the next time you sign in.
          </p>
          <Link href="/dashboard" className="text-sm text-primary-600 hover:underline">
            Back to dashboard
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-1">
            <label htmlFor="current" className="text-sm font-medium text-neutral-700">
              Current password
            </label>
            <input
              id="current"
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="new" className="text-sm font-medium text-neutral-700">
              New password
            </label>
            <input
              id="new"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none"
            />
            <PasswordStrengthMeter
              password={newPassword}
              policy={policy}
              context={{
                email: me?.email ?? '',
                firstName: me?.firstName,
                lastName: me?.lastName,
              }}
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
            {submitting ? 'Updating…' : 'Update password'}
          </button>
        </form>
      )}
    </div>
  );
}
