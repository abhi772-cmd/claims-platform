'use client';

// Profile hub — landing page for /me. Shows the signed-in user's
// identity and links to the account sub-pages (password, MFA,
// sessions, trusted devices).

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { useErrorModal } from '../../../components/modals/ErrorModal/ErrorModalProvider';
import { AuthApi } from '../../../lib/api/auth.api';
import { ApiError } from '../../../lib/api/client';

interface AccountTile {
  href: string;
  title: string;
  description: string;
  icon: string;
}

const TILES: AccountTile[] = [
  {
    href: '/me/change-password',
    title: 'Change password',
    description: 'Update your password — Argon2id, min 12 chars.',
    icon: 'lock_reset',
  },
  {
    href: '/me/mfa',
    title: 'Two-factor (MFA)',
    description: 'TOTP authenticator + backup codes.',
    icon: 'encrypted',
  },
  {
    href: '/me/sessions',
    title: 'Active sessions',
    description: 'Devices currently signed in to your account.',
    icon: 'devices',
  },
  {
    href: '/me/trusted-devices',
    title: 'Trusted devices',
    description: 'Devices that skip the MFA prompt for 30 days.',
    icon: 'verified_user',
  },
];

export default function ProfileHubPage(): JSX.Element {
  const router = useRouter();
  const { showApiError } = useErrorModal();

  const me = useQuery({
    queryKey: ['me'],
    queryFn: ({ signal }) => AuthApi.me(signal),
  });

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.problem.status === 401) {
      router.replace('/login');
      return;
    }
    if (me.error) showApiError(me.error);
  }, [me.error, router, showApiError]);

  if (me.isLoading) {
    return (
      <div className="glass max-w-md rounded-xl p-6">
        <p className="text-body text-on-surface-variant">Loading…</p>
      </div>
    );
  }
  if (!me.data) return <></>;

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-6">
      {/* Identity hero */}
      <section className="relative overflow-hidden rounded-xl border border-white/20 bg-gradient-to-br from-primary to-primary-container p-8 text-on-primary shadow-[0_8px_30px_rgba(0,102,110,0.15)]">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-[10%] -top-[20%] h-[60%] w-[60%] rounded-full bg-secondary-container/10 blur-[40px]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-[10%] -left-[10%] h-[40%] w-[40%] rounded-full bg-primary-fixed-dim/20 blur-[40px]"
        />

        <div className="relative flex flex-wrap items-center gap-5">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-secondary-container text-h3 font-bold text-on-secondary-container">
            {(me.data.firstName[0] ?? '').toUpperCase()}
            {(me.data.lastName[0] ?? '').toUpperCase()}
          </div>
          <div>
            <span className="text-eyebrow uppercase tracking-eyebrow text-primary-fixed-dim">
              {me.data.tenantDisplayName}
            </span>
            <h2 className="text-h2 font-h2 text-secondary-fixed">
              {me.data.firstName} {me.data.lastName}
            </h2>
            <p className="mt-0.5 flex items-center gap-1 text-body text-on-primary/80">
              <span className="material-symbols-outlined text-[16px]">mail</span>
              {me.data.email}
            </p>
          </div>
        </div>
        <div className="relative mt-5 flex flex-wrap gap-2">
          {me.data.roles.length === 0 ? (
            <span className="text-body-sm text-on-primary/60">No roles assigned</span>
          ) : (
            me.data.roles.map((r) => (
              <span
                key={r}
                className="inline-flex items-center gap-1 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-body-sm font-medium text-on-primary backdrop-blur-sm"
              >
                <span className="material-symbols-outlined text-[14px]">badge</span>
                {r}
              </span>
            ))
          )}
        </div>
      </section>

      {me.data.mustChangePassword ? (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-white/50 border-l-white border-t-white bg-secondary-fixed/50 p-4 shadow-sm backdrop-blur-[24px]">
          <div className="flex items-center gap-3 text-secondary">
            <span className="material-symbols-outlined">warning</span>
            <span className="text-body font-medium">
              You signed in with a temporary password — change it before continuing real work.
            </span>
          </div>
          <Link
            href="/me/change-password"
            className="rounded-full border-[1.5px] border-secondary bg-white/50 px-4 py-1.5 text-eyebrow uppercase tracking-eyebrow text-secondary backdrop-blur-sm transition-colors hover:bg-secondary/10"
          >
            Change now
          </Link>
        </div>
      ) : null}

      {/* Account tiles */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {TILES.map((t) => (
          <Link key={t.href} href={t.href} className="group">
            <div className="glass flex h-full items-start gap-4 rounded-xl p-6 transition-all group-hover:-translate-y-0.5 group-hover:shadow-lg">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary-fixed-dim/30 text-primary transition-transform group-hover:scale-110">
                <span className="material-symbols-outlined">{t.icon}</span>
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-body font-semibold text-on-surface">{t.title}</div>
                <p className="mt-0.5 text-body-sm text-on-surface-variant">{t.description}</p>
              </div>
              <span
                className="material-symbols-outlined self-center text-primary"
                aria-hidden
              >
                arrow_forward
              </span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
