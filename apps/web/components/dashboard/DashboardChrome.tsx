'use client';

// Dashboard chrome — Stitch-canonical layout.
//   ┌──────────────────┬──────────────────────────────────────────┐
//   │  [DIGI SPARSH]   │  [glass topbar: breadcrumb · status · +] │
//   │  Operations      ├──────────────────────────────────────────┤
//   │   ● Dashboard    │                                          │
//   │   · Claims       │     <main /> page content                │
//   │   · ...          │                                          │
//   │  Compliance      │                                          │
//   │   ...            │                                          │
//   │  ────────────    │                                          │
//   │  user pill ▸     │                                          │
//   └──────────────────┴──────────────────────────────────────────┘
//
// The deep-teal sidebar uses Material Symbols icons + primary-fixed-dim
// muted text for inactive items and a white/secondary-container border-l
// accent on the active row. Topbar is glass with the active page's title
// and tenant chip + primary-gradient "New case" CTA.

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { AuthApi } from '../../lib/api/auth.api';
import { ApiError } from '../../lib/api/client';
import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';

interface NavItem {
  href: string;
  label: string;
  icon: string; // Material Symbols name
}
interface NavGroup {
  title: string;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    title: 'Operations',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
      { href: '/cases', label: 'Cases', icon: 'clinical_notes' },
      { href: '/cases/new', label: 'New case', icon: 'note_add' },
      { href: '/admin/remittance', label: 'Settlement / EOB', icon: 'payments' },
      { href: '/admin/variance', label: 'Variance', icon: 'monitoring' },
    ],
  },
  {
    title: 'Compliance',
    items: [
      { href: '/admin/compliance', label: 'Compliance', icon: 'verified_user' },
      { href: '/admin/consents', label: 'Consents', icon: 'task_alt' },
      { href: '/admin/audit', label: 'Audit log', icon: 'manage_search' },
    ],
  },
  {
    title: 'Tenant admin',
    items: [
      { href: '/admin/onboarding', label: 'Onboarding', icon: 'domain_add' },
      { href: '/admin/lifecycle', label: 'Lifecycle', icon: 'orbit' },
      { href: '/admin/users', label: 'Users', icon: 'group' },
      { href: '/admin/security', label: 'Security', icon: 'shield_lock' },
      { href: '/admin/comms-config', label: 'Comms', icon: 'forum' },
    ],
  },
  {
    title: 'Platform ops',
    items: [
      { href: '/admin/tenants', label: 'Hospitals', icon: 'apartment' },
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

  // Which group is the current path in? That group opens by default;
  // the others stay collapsed so the sidebar is calmer at rest. Users
  // can click any group header to toggle it.
  const activeGroupTitle = useMemo(() => {
    for (const group of NAV) {
      const has = group.items.some(
        (i) => pathname === i.href || pathname?.startsWith(`${i.href}/`),
      );
      if (has) return group.title;
    }
    return NAV[0]?.title ?? null;
  }, [pathname]);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(NAV.map((g) => [g.title, g.title === activeGroupTitle])),
  );
  // Keep the active group open as the user navigates between sections.
  useEffect(() => {
    if (activeGroupTitle) {
      setOpenGroups((cur) =>
        cur[activeGroupTitle] ? cur : { ...cur, [activeGroupTitle]: true },
      );
    }
  }, [activeGroupTitle]);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);

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
        showApiError(err);
      });
    return () => {
      ctrl.abort();
    };
  }, [router, showApiError]);

  const pageTitle = useMemo(() => deriveTitle(pathname ?? '/dashboard'), [pathname]);

  const onSignOut = async (): Promise<void> => {
    try {
      await AuthApi.logout();
    } catch {
      // Cookie is httpOnly; the next /auth/me will 401 and bounce.
    }
    router.replace('/login');
  };

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="font-nav sticky top-0 z-50 flex h-screen w-64 shrink-0 flex-col bg-gradient-to-b from-[#0d7a82] to-[#075c63] px-4 py-8 text-on-primary shadow-xl">
        {/* Brand pill */}
        <div className="mb-10 px-2">
          <div className="inline-flex items-center gap-2 rounded-full bg-surface-container-lowest px-4 py-2 shadow-sm">
            <span
              className="material-symbols-outlined text-primary"
              style={{ fontSize: 22, fontVariationSettings: "'FILL' 1" }}
            >
              health_and_safety
            </span>
            <span className="text-h3 font-black uppercase tracking-tighter text-primary">
              DIGI SPARSH
            </span>
          </div>
          <p className="mt-3 px-1 text-eyebrow uppercase tracking-eyebrow text-primary-fixed/70">
            Healthcare Claims
          </p>
        </div>

        {/* Nav groups — clubbed dropdowns. Group header is a button;
            click to toggle. Active group auto-opens on navigate. */}
        <nav className="font-nav flex flex-1 flex-col gap-2 overflow-y-auto">
          {NAV.map((group) => {
            const isOpen = openGroups[group.title] ?? false;
            const groupHasActive = group.items.some(
              (i) => pathname === i.href || pathname?.startsWith(`${i.href}/`),
            );
            return (
              <div key={group.title} className="rounded-lg">
                <button
                  type="button"
                  onClick={() =>
                    setOpenGroups((cur) => ({ ...cur, [group.title]: !cur[group.title] }))
                  }
                  aria-expanded={isOpen}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left transition-colors hover:bg-white/5 ${
                    groupHasActive ? 'text-white' : 'text-white/80'
                  }`}
                >
                  <span className="text-[11px] font-bold uppercase tracking-[0.14em]">
                    {group.title}
                  </span>
                  <span
                    className="material-symbols-outlined text-[18px] transition-transform"
                    style={{ transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }}
                  >
                    expand_more
                  </span>
                </button>
                {isOpen && (
                  <ul className="ml-1 mt-1 space-y-0.5 border-l border-white/10 pl-2">
                    {group.items.map((item) => {
                      const active =
                        pathname === item.href || pathname?.startsWith(`${item.href}/`);
                      return (
                        <li key={item.href}>
                          <Link
                            href={item.href}
                            aria-current={active ? 'page' : undefined}
                            className={
                              active
                                ? 'flex items-center gap-3 rounded-lg border-l-2 border-secondary-container bg-white/10 px-3 py-2 font-semibold text-white transition-all'
                                : 'flex items-center gap-3 rounded-lg px-3 py-2 font-medium text-white/85 transition-all hover:bg-white/5 hover:text-white'
                            }
                          >
                            <span
                              className="material-symbols-outlined text-[20px]"
                              style={
                                active ? { fontVariationSettings: "'FILL' 1" } : undefined
                              }
                            >
                              {item.icon}
                            </span>
                            <span className="text-[14px]">{item.label}</span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}

        </nav>

        {/* Sidebar footer — user chip + sign out */}
        <div className="mt-auto flex flex-col gap-2 border-t border-white/10 pt-6">
          {me ? (
            <div className="rounded-lg bg-white/5 p-3">
              <div className="flex items-center gap-2">
                <div className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-secondary-container text-body-sm font-bold text-on-secondary-container">
                  {(me.firstName[0] ?? '').toUpperCase()}
                  {(me.lastName[0] ?? '').toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body-sm font-semibold text-on-primary">
                    {me.firstName} {me.lastName}
                  </div>
                  <div className="truncate text-eyebrow uppercase tracking-eyebrow text-white/70">
                    {me.tenantDisplayName}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  void onSignOut();
                }}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-white/20 py-1.5 text-eyebrow uppercase tracking-eyebrow text-on-primary/90 transition hover:bg-white/10"
              >
                <span className="material-symbols-outlined text-[16px]">logout</span>
                Sign out
              </button>
            </div>
          ) : (
            <div className="text-body-sm text-white/70">
              Loading session…
            </div>
          )}
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-h-screen flex-1 flex-col">
        {/* Topbar — glass strip with breadcrumb + tenant chip + New case CTA */}
        <header className="sticky top-0 z-40 flex h-16 items-center justify-between border-b border-white/20 bg-surface/70 px-6 backdrop-blur-md">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-body-sm text-on-surface-variant">{pageTitle.crumb}</span>
            <span className="text-on-surface-variant/40">/</span>
            <h1 className="truncate text-h3 font-h3 font-bold text-primary">
              {pageTitle.title}
            </h1>
          </div>

          <div className="flex items-center gap-4">
            {me ? (
              <div className="hidden items-center gap-2 rounded-full border border-primary/10 bg-primary/5 px-3 py-1.5 md:flex">
                <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
                <span className="text-body-sm font-semibold text-primary">
                  {me.tenantDisplayName}
                </span>
                <span className="text-on-surface-variant/40">·</span>
                <span className="font-mono text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                  {me.roles[0] ?? '—'}
                </span>
              </div>
            ) : null}

            <Link
              href="/cases/new"
              className="btn-primary"
              style={{ padding: '8px 16px', fontSize: '13px' }}
            >
              <span
                className="material-symbols-outlined"
                style={{ fontSize: 18, fontVariationSettings: "'FILL' 1" }}
              >
                add
              </span>
              New case
            </Link>

            <div className="flex items-center gap-3 border-l border-outline-variant/30 pl-4">
              <button
                type="button"
                aria-label="Notifications"
                className="text-on-surface-variant transition-colors hover:text-primary"
              >
                <span className="material-symbols-outlined">notifications</span>
              </button>

              {/* Profile menu — replaces the sidebar Account dropdown.
                  Click the avatar to open; click outside (or any item)
                  to close. Menu is anchored to the right edge. */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setProfileMenuOpen((v) => !v)}
                  aria-label="Account menu"
                  aria-haspopup="menu"
                  aria-expanded={profileMenuOpen}
                  className={`inline-flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-body-sm font-bold text-primary transition hover:bg-primary/20 ${
                    profileMenuOpen ? 'ring-2 ring-primary/40' : ''
                  }`}
                >
                  {me
                    ? `${(me.firstName[0] ?? '').toUpperCase()}${(me.lastName[0] ?? '').toUpperCase()}`
                    : '…'}
                </button>
                {profileMenuOpen && (
                  <>
                    {/* Click-away overlay. Captures the click that
                        closes the menu without blocking other UI. */}
                    <button
                      type="button"
                      aria-hidden="true"
                      tabIndex={-1}
                      onClick={() => setProfileMenuOpen(false)}
                      className="fixed inset-0 z-10 cursor-default bg-transparent"
                    />
                    <div
                      role="menu"
                      className="absolute right-0 top-full z-20 mt-2 w-64 overflow-hidden rounded-xl border border-outline-variant/40 bg-surface shadow-lg"
                    >
                      {me ? (
                        <div className="border-b border-outline-variant/30 px-4 py-3">
                          <div className="truncate text-body-sm font-semibold text-on-surface">
                            {me.firstName} {me.lastName}
                          </div>
                          <div className="truncate text-body-sm text-on-surface-variant">
                            {me.email}
                          </div>
                          <div className="mt-1 truncate text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                            {me.tenantDisplayName}
                          </div>
                        </div>
                      ) : null}
                      <Link
                        href="/me"
                        role="menuitem"
                        onClick={() => setProfileMenuOpen(false)}
                        className="flex items-center gap-3 px-4 py-2.5 text-body text-on-surface transition hover:bg-primary/5"
                      >
                        <span className="material-symbols-outlined text-[20px] text-on-surface-variant">
                          account_circle
                        </span>
                        My profile
                      </Link>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setProfileMenuOpen(false);
                          void onSignOut();
                        }}
                        className="flex w-full items-center gap-3 border-t border-outline-variant/30 px-4 py-2.5 text-body text-on-surface transition hover:bg-primary/5"
                      >
                        <span className="material-symbols-outlined text-[20px] text-on-surface-variant">
                          logout
                        </span>
                        Sign out
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </header>

        <main className="flex-1 px-6 pb-10 pt-6">{children}</main>
      </div>
    </div>
  );
}

// ---- helpers ----

function deriveTitle(pathname: string): { crumb: string; title: string } {
  const segments = pathname.split('/').filter(Boolean);
  const head = segments[0];
  if (!head) return { crumb: 'Operations', title: 'Dashboard' };

  const map: Record<string, { crumb: string; title: string }> = {
    dashboard: { crumb: 'Operations', title: 'Dashboard' },
    cases: { crumb: 'Operations', title: 'Cases' },
    me: { crumb: 'Account', title: 'My profile' },
  };
  if (head === 'admin') {
    const sub = segments[1] ?? '';
    const adminMap: Record<string, string> = {
      compliance: 'Compliance',
      consents: 'Consents',
      audit: 'Audit log',
      onboarding: 'Tenant onboarding',
      lifecycle: 'Tenant lifecycle',
      users: 'Users',
      security: 'Security',
      'comms-config': 'Comms config',
      remittance: 'Settlement / EOB',
    };
    return {
      crumb: 'Admin',
      title: adminMap[sub] ?? humanize(sub),
    };
  }
  if (head === 'cases' && segments[1] === 'new') {
    return { crumb: 'Operations', title: 'New case' };
  }
  if (head === 'cases' && segments[1]) {
    return { crumb: 'Operations', title: `Case ${segments[1].slice(0, 8)}…` };
  }
  if (head === 'me' && segments[1] === 'change-password') {
    return { crumb: 'Account', title: 'Change password' };
  }
  if (head === 'me' && segments[1] === 'mfa') {
    return { crumb: 'Account', title: 'Two-factor authentication' };
  }
  return map[head] ?? { crumb: humanize(head), title: humanize(segments.at(-1) ?? head) };
}

function humanize(slug: string): string {
  return slug
    .split('-')
    .map((s) => (s ? s[0]!.toUpperCase() + s.slice(1) : s))
    .join(' ');
}
