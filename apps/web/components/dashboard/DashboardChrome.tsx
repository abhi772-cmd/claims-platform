'use client';

// Dashboard chrome — sidebar nav + top bar with user/tenant context
// + sign-out. Lives in the (dashboard) route group so it wraps every
// authenticated screen.
//
// Nav is grouped semantically so demos and operators can follow
// the workflow without remembering URLs:
//   1. Operations — daily work (cases, eligibility, settlement)
//   2. Compliance — DPDP / IRDAI / RBI surface (audit, consents,
//      breaches, compliance dashboard)
//   3. Tenant admin — onboarding, lifecycle, users, security,
//      master data, comms
//   4. Account — current user / sign out

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';

import { AuthApi } from '../../lib/api/auth.api';
import { ApiError } from '../../lib/api/client';
import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';

interface NavItem {
  href: string;
  label: string;
  description?: string;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    title: 'Operations',
    items: [
      { href: '/dashboard', label: 'Home' },
      { href: '/cases', label: 'Cases', description: 'Claim aggregate' },
      { href: '/cases/new', label: 'New case', description: 'Admission + consent' },
      { href: '/admin/remittance', label: 'Settlement / EOB', description: 'Upload + extract' },
    ],
  },
  {
    title: 'Compliance',
    items: [
      { href: '/admin/compliance', label: 'Compliance dashboard', description: 'DPDP rollup' },
      { href: '/admin/consents', label: 'Consents', description: 'DPDP §6 records' },
      { href: '/admin/audit', label: 'Audit log', description: 'Tenant-scoped' },
    ],
  },
  {
    title: 'Tenant admin',
    items: [
      { href: '/admin/onboarding', label: 'Onboarding', description: 'Tenant setup wizard' },
      { href: '/admin/lifecycle', label: 'Lifecycle', description: 'Tenant state' },
      { href: '/admin/users', label: 'Users', description: 'Invite / manage' },
      { href: '/admin/security', label: 'Security', description: 'IP / sessions / MFA' },
      { href: '/admin/comms-config', label: 'Comms config', description: 'SMTP / SMS' },
    ],
  },
  {
    title: 'Account',
    items: [
      { href: '/me', label: 'My profile' },
    ],
  },
];

interface MeMinimal {
  firstName: string;
  lastName: string;
  email: string;
  tenantDisplayName: string;
  roles: string[];
}

export function DashboardChrome({ children }: { children: ReactNode }): JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const { showApiError } = useErrorModal();
  const [me, setMe] = useState<MeMinimal | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    AuthApi.me(ctrl.signal)
      .then((d) => {
        setMe({
          firstName: d.firstName,
          lastName: d.lastName,
          email: d.email,
          tenantDisplayName: d.tenantDisplayName,
          roles: d.roles,
        });
      })
      .catch((err) => {
        if (err instanceof ApiError && err.problem.status === 401) {
          router.replace('/login');
          return;
        }
        // Don't bombard the user with auth errors on every nav re-render;
        // only surface non-auth failures.
        showApiError(err);
      });
    return () => {
      ctrl.abort();
    };
  }, [router, showApiError]);

  const onSignOut = async (): Promise<void> => {
    try {
      await AuthApi.logout();
    } catch {
      // Best-effort. The cookie is httpOnly so even if the network
      // call fails the next /auth/me will 401 and bounce to login.
    }
    router.replace('/login');
  };

  return (
    <div className="flex min-h-screen bg-neutral-50">
      <aside className="flex w-60 flex-col border-r border-neutral-200 bg-neutral-0">
        <div className="flex h-16 items-center border-b border-neutral-200 px-5">
          <Link href="/dashboard" className="text-base font-semibold text-neutral-800">
            DigiSparsh Claims
          </Link>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 py-4 text-sm">
          {NAV.map((group) => (
            <div key={group.title} className="mb-5">
              <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
                {group.title}
              </div>
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const active =
                    pathname === item.href || pathname?.startsWith(`${item.href}/`);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className={
                          active
                            ? 'block rounded-sm bg-primary-50 px-2 py-1.5 text-primary-700'
                            : 'block rounded-sm px-2 py-1.5 text-neutral-700 hover:bg-neutral-100'
                        }
                      >
                        <div className="font-medium">{item.label}</div>
                        {item.description ? (
                          <div className="text-[10.5px] text-neutral-500">{item.description}</div>
                        ) : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
        <div className="border-t border-neutral-200 px-3 py-3 text-xs">
          {me ? (
            <div className="space-y-1">
              <div className="font-medium text-neutral-800">
                {me.firstName} {me.lastName}
              </div>
              <div className="text-neutral-500">{me.tenantDisplayName}</div>
              <div className="font-mono text-[10px] text-neutral-400">
                {me.roles.join(', ')}
              </div>
              <button
                type="button"
                onClick={() => {
                  void onSignOut();
                }}
                className="mt-2 w-full rounded-sm border border-neutral-200 px-2 py-1 text-neutral-700 hover:bg-neutral-50"
              >
                Sign out
              </button>
            </div>
          ) : (
            <div className="text-neutral-400">Loading session…</div>
          )}
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto px-6 py-6">{children}</main>
    </div>
  );
}
