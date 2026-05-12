'use client';

import { type MeResponse, type PasswordPolicyDescriptor } from '@claims/contracts';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';

import { AuthField } from '../../../../components/auth/AuthField';
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
    <div className="mx-auto w-full max-w-[560px]">
      <div className="glass rounded-lg p-10 shadow-lg">
        <div className="mb-8">
          <span className="mb-2 block text-eyebrow uppercase tracking-eyebrow text-primary">
            Account security
          </span>
          <h2 className="text-h2 font-h2 text-on-surface">Change password</h2>
        </div>

        {done ? (
          <div className="space-y-3 rounded-lg border border-emerald-500/25 bg-emerald-50 p-5">
            <p className="text-body font-semibold text-emerald-700">Password updated.</p>
            <p className="text-body-sm text-emerald-700">
              Use your new password the next time you sign in.
            </p>
            <Link
              href="/dashboard"
              className="inline-block text-body-sm font-medium text-primary hover:underline"
            >
              Back to dashboard →
            </Link>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-6" noValidate>
            <AuthField
              label="Current password"
              icon="lock"
              password
              id="current"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="••••••••••••"
            />

            <div className="space-y-2">
              <AuthField
                label="New password"
                icon="lock_reset"
                password
                id="new"
                autoComplete="new-password"
                required
                minLength={12}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter new password"
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
              placeholder="Re-enter new password"
            />

            <div className="flex items-center gap-4 pt-4">
              <button
                type="submit"
                disabled={submitting}
                className="btn-primary flex-1"
                style={{ padding: '14px 24px', fontSize: '14px' }}
              >
                {submitting ? 'Updating…' : 'Update password'}
              </button>
              <Link href="/dashboard" className="btn-outline" style={{ padding: '14px 24px' }}>
                Cancel
              </Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
