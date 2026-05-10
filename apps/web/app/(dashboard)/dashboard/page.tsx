'use client';

// Dashboard home — welcome + tenant context + quick-access tiles
// for the main demo flows. Replaces the bare welcome banner that
// landed in Sprint 1 with a shortcut-driven landing surface so
// operators (and demos) have a clear entry point into each
// workflow.

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { useErrorModal } from '../../../components/modals/ErrorModal/ErrorModalProvider';
import { AuthApi } from '../../../lib/api/auth.api';
import { ApiError } from '../../../lib/api/client';
import { ComplianceApi } from '../../../lib/api/compliance.api';

interface QuickTile {
  title: string;
  description: string;
  href: string;
  accent: 'blue' | 'green' | 'amber' | 'red';
}

const QUICK_TILES: QuickTile[] = [
  {
    title: 'Create a new case',
    description: 'Admission + patient PII + DPDP §6 consent capture',
    href: '/cases/new',
    accent: 'blue',
  },
  {
    title: 'Open cases',
    description: 'Eligibility → preauth → claim submit → settlement',
    href: '/cases',
    accent: 'green',
  },
  {
    title: 'Compliance dashboard',
    description: 'Audit retention, breach incidents, consent rollup',
    href: '/admin/compliance',
    accent: 'amber',
  },
  {
    title: 'Settlement / EOB',
    description: 'Upload payer EOB and auto-extract structured fields',
    href: '/admin/remittance',
    accent: 'red',
  },
];

const ACCENT_CLASSES: Record<QuickTile['accent'], string> = {
  blue: 'bg-blue-50 border-blue-200 text-blue-900 hover:bg-blue-100',
  green: 'bg-green-50 border-green-200 text-green-900 hover:bg-green-100',
  amber: 'bg-amber-50 border-amber-200 text-amber-900 hover:bg-amber-100',
  red: 'bg-red-50 border-red-200 text-red-900 hover:bg-red-100',
};

export default function DashboardPage(): JSX.Element {
  const router = useRouter();
  const { showApiError } = useErrorModal();

  const me = useQuery({
    queryKey: ['me'],
    queryFn: ({ signal }) => AuthApi.me(signal),
  });

  // Failures here are non-blocking — the home page just hides
  // the stat strip if it can't load. Don't bombard the modal.
  const compliance = useQuery({
    queryKey: ['compliance-dashboard-summary'],
    queryFn: () => ComplianceApi.dashboard(),
    enabled: me.data !== undefined,
    retry: false,
  });

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.problem.status === 401) {
      router.replace('/login');
      return;
    }
    if (me.error) showApiError(me.error);
  }, [me.error, router, showApiError]);

  if (me.isLoading) {
    return <p className="text-sm text-neutral-500">Loading…</p>;
  }
  if (!me.data) return <></>;

  const summary = compliance.data;
  const overdueOpen = summary?.openBreaches.filter((b) => b.overdue).length ?? 0;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-2xl font-semibold text-neutral-800">
          Welcome, {me.data.firstName} {me.data.lastName}.
        </h2>
        <p className="text-sm text-neutral-500">
          {me.data.tenantDisplayName} · roles: {me.data.roles.join(', ') || '—'}
        </p>
        {me.data.mustChangePassword ? (
          <p className="rounded-sm bg-warning-50 px-3 py-2 text-sm text-warning-700">
            You should change your password before continuing real work. Visit{' '}
            <Link href="/me" className="underline">
              your profile
            </Link>{' '}
            to update it.
          </p>
        ) : null}
      </header>

      {/* Compliance pulse — only shown when the dashboard endpoint
          returned data. Operators land here and can see if anything
          urgent is open. */}
      {summary && (
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat
            label="Open breaches"
            value={summary.breachCounts.detected}
            accent={summary.breachCounts.detected > 0 ? 'red' : 'gray'}
          />
          <Stat
            label="Overdue (72h)"
            value={overdueOpen}
            accent={overdueOpen > 0 ? 'red' : 'gray'}
          />
          <Stat
            label="Active consents"
            value={summary.consentCounts.granted}
            accent="green"
          />
          <Stat
            label="Unbound access (24h)"
            value={summary.unboundAccessCountLast24h}
            accent={summary.unboundAccessCountLast24h > 0 ? 'amber' : 'gray'}
          />
        </section>
      )}

      {/* Quick-access tiles. Map 1:1 to the demo flow: create a
          case, work the queue, monitor compliance, run settlement. */}
      <section>
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-neutral-500">
          Quick actions
        </h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {QUICK_TILES.map((tile) => (
            <Link
              key={tile.href}
              href={tile.href}
              className={`block rounded-md border p-4 transition ${ACCENT_CLASSES[tile.accent]}`}
            >
              <div className="text-base font-semibold">{tile.title}</div>
              <div className="mt-1 text-xs opacity-80">{tile.description}</div>
            </Link>
          ))}
        </div>
      </section>

      <section className="text-xs text-neutral-500">
        <p>
          Need to capture consent for an existing patient? Go to{' '}
          <Link href="/admin/consents" className="underline">
            Consents
          </Link>
          . Looking at audit history? Try the{' '}
          <Link href="/admin/audit" className="underline">
            Audit log
          </Link>
          .
        </p>
      </section>
    </div>
  );
}

interface StatProps {
  label: string;
  value: number;
  accent: 'red' | 'amber' | 'green' | 'gray';
}

function Stat({ label, value, accent }: StatProps): JSX.Element {
  const cls: Record<StatProps['accent'], string> = {
    red: 'bg-red-50 border-red-200 text-red-800',
    amber: 'bg-amber-50 border-amber-200 text-amber-800',
    green: 'bg-green-50 border-green-200 text-green-800',
    gray: 'bg-neutral-50 border-neutral-200 text-neutral-700',
  };
  return (
    <div className={`rounded border p-3 ${cls[accent]}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-80">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value.toLocaleString()}</div>
    </div>
  );
}
