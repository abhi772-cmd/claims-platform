'use client';

// Slice BU — DPDP / IRDAI / RBI compliance dashboard.
//
// One screen surfacing every compliance signal the operator needs:
//   - Audit retention class breakdown (rows + past-floor counts)
//   - Recent erasure requests (completed / rejected with blocking-claims count)
//   - Recent decrypt events bound to consent grants
//   - Open breach incidents with overdue 72h banner + inline notify/dismiss
//   - Consent rollup + recent grants/withdrawals
//   - "Unbound access in past 24h" — engineering triage signal
//
// Permission: audit.view (same as the audit log viewer). The
// breach notify/dismiss buttons additionally require
// breach_incident.manage; the API gates and the catch surfaces the
// 403 to the user via the error modal.

import { type ComplianceDashboard } from '@claims/contracts';
import { useEffect, useState } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { BreachApi } from '../../../../lib/api/breach.api';
import { ComplianceApi } from '../../../../lib/api/compliance.api';

export default function ComplianceDashboardPage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const [data, setData] = useState<ComplianceDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    ComplianceApi.dashboard()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => showApiError(err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, showApiError]);

  const refresh = (): void => setRefreshKey((k) => k + 1);

  const runScan = async (): Promise<void> => {
    setScanning(true);
    try {
      const r = await BreachApi.scan();
      window.alert(
        `Scan complete: ${r.incidentsCreated} new incident(s) in ${r.durationMs}ms.`,
      );
      refresh();
    } catch (err) {
      showApiError(err);
    } finally {
      setScanning(false);
    }
  };

  const notify = async (id: string): Promise<void> => {
    if (!window.confirm('Notify the Data Protection Board for this incident?')) return;
    try {
      await BreachApi.notify(id, { acknowledged: true });
      refresh();
    } catch (err) {
      showApiError(err);
    }
  };

  const dismiss = async (id: string): Promise<void> => {
    const reason = window.prompt('Reason for dismissal (min 10 chars):');
    if (!reason || reason.length < 10) return;
    try {
      await BreachApi.dismiss(id, { reason });
      refresh();
    } catch (err) {
      showApiError(err);
    }
  };

  if (loading && !data) {
    return <div className="p-6 text-gray-500">Loading compliance snapshot…</div>;
  }
  if (!data) {
    return <div className="p-6 text-gray-500">No data available.</div>;
  }

  const overdueOpen = data.openBreaches.filter((b) => b.overdue).length;

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Compliance dashboard</h1>
          <p className="text-sm text-gray-600">
            DPDP Act 2023 + IRDAI 5y + RBI 10y rollup. Snapshot generated{' '}
            {new Date(data.generatedAt).toLocaleString()}.
          </p>
        </div>
        <div className="space-x-2">
          <button
            type="button"
            onClick={refresh}
            className="rounded border px-4 py-2 hover:bg-gray-50"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => {
              void runScan();
            }}
            disabled={scanning}
            className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {scanning ? 'Scanning…' : 'Run breach scan'}
          </button>
        </div>
      </header>

      {overdueOpen > 0 && (
        <section className="rounded border border-red-300 bg-red-50 p-4">
          <p className="font-semibold text-red-800">
            {overdueOpen} open breach incident(s) past the 72-hour DPDP §8(6)
            notification deadline. Notify the Data Protection Board immediately.
          </p>
        </section>
      )}

      {/* Top-row cards */}
      <section className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <Card title="Open breaches" value={data.breachCounts.detected} accent="red" />
        <Card title="Notified breaches" value={data.breachCounts.notified} accent="amber" />
        <Card title="Active consents" value={data.consentCounts.granted} accent="green" />
        <Card
          title="Unbound access (24h)"
          value={data.unboundAccessCountLast24h}
          accent={data.unboundAccessCountLast24h > 0 ? 'amber' : 'gray'}
        />
      </section>

      {/* Retention class */}
      <section>
        <h2 className="mb-2 text-lg font-semibold">Audit retention</h2>
        <table className="w-full table-auto border-collapse text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left">
              <th className="px-3 py-2">Class</th>
              <th className="px-3 py-2 text-right">Total rows</th>
              <th className="px-3 py-2 text-right">Past floor</th>
            </tr>
          </thead>
          <tbody>
            {data.retentionClasses.map((r) => (
              <tr key={r.retentionClass} className="border-b">
                <td className="px-3 py-2 font-mono text-xs">{r.retentionClass}</td>
                <td className="px-3 py-2 text-right">{r.total.toLocaleString()}</td>
                <td className="px-3 py-2 text-right">
                  {r.pastFloor > 0 ? (
                    <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                      {r.pastFloor.toLocaleString()}
                    </span>
                  ) : (
                    <span className="text-gray-400">0</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Open breaches */}
      <section>
        <h2 className="mb-2 text-lg font-semibold">Open breach incidents</h2>
        <table className="w-full table-auto border-collapse text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left">
              <th className="px-3 py-2">Opened</th>
              <th className="px-3 py-2">Kind</th>
              <th className="px-3 py-2">Severity</th>
              <th className="px-3 py-2">Affected</th>
              <th className="px-3 py-2">Due</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {data.openBreaches.map((b) => (
              <tr key={b.id} className={`border-b ${b.overdue ? 'bg-red-50' : ''}`}>
                <td className="px-3 py-2 text-xs">{new Date(b.openedAt).toLocaleString()}</td>
                <td className="px-3 py-2 font-mono text-xs">{b.kind}</td>
                <td className="px-3 py-2 text-xs">{b.severity}</td>
                <td className="px-3 py-2 text-right">{b.affectedDataPrincipals}</td>
                <td className="px-3 py-2 text-xs">
                  {new Date(b.dpdpNotificationDueAt).toLocaleString()}
                  {b.overdue && (
                    <span className="ml-2 rounded bg-red-200 px-2 py-0.5 text-xs text-red-900">
                      OVERDUE
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 space-x-2 whitespace-nowrap">
                  <button
                    type="button"
                    onClick={() => {
                      void notify(b.id);
                    }}
                    className="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700"
                  >
                    Notify
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void dismiss(b.id);
                    }}
                    className="rounded border border-gray-400 px-2 py-1 text-xs hover:bg-gray-50"
                  >
                    Dismiss
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.openBreaches.length === 0 && (
          <p className="py-4 text-center text-sm text-gray-500">No open breach incidents.</p>
        )}
      </section>

      {/* Recent data access */}
      <section>
        <h2 className="mb-2 text-lg font-semibold">Recent decrypt events</h2>
        <table className="w-full table-auto border-collapse text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left">
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">Actor</th>
              <th className="px-3 py-2">Resource</th>
              <th className="px-3 py-2">Fields</th>
              <th className="px-3 py-2">Purpose</th>
              <th className="px-3 py-2">Consent</th>
            </tr>
          </thead>
          <tbody>
            {data.recentDataAccess.map((e) => (
              <tr key={e.id} className="border-b">
                <td className="px-3 py-2 text-xs">{new Date(e.occurredAt).toLocaleString()}</td>
                <td className="px-3 py-2 font-mono text-xs">
                  {e.actorUserId ? `${e.actorType}:${e.actorUserId.slice(0, 8)}` : e.actorType}
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {e.resourceType}
                  {e.resourceId ? ` / ${e.resourceId.slice(0, 8)}` : ''}
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {e.fieldNames?.join(', ') ?? '—'}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{e.purpose}</td>
                <td className="px-3 py-2">
                  <ConsentBadge status={e.consentStatus} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.recentDataAccess.length === 0 && (
          <p className="py-4 text-center text-sm text-gray-500">No recent decrypt events.</p>
        )}
      </section>

      {/* Recent erasures */}
      <section>
        <h2 className="mb-2 text-lg font-semibold">Recent erasure requests</h2>
        <p className="mb-2 text-xs text-gray-600">
          Last 90 days: {data.erasureCounts.completed} completed,{' '}
          {data.erasureCounts.rejected} rejected.
        </p>
        <table className="w-full table-auto border-collapse text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left">
              <th className="px-3 py-2">Filed</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Patient</th>
              <th className="px-3 py-2">Blocking claims</th>
            </tr>
          </thead>
          <tbody>
            {data.recentErasures.map((e) => (
              <tr key={e.id} className="border-b">
                <td className="px-3 py-2 text-xs">{new Date(e.createdAt).toLocaleString()}</td>
                <td className="px-3 py-2">
                  <span
                    className={
                      e.status === 'completed'
                        ? 'rounded bg-green-100 px-2 py-0.5 text-xs text-green-800'
                        : 'rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800'
                    }
                  >
                    {e.status}
                  </span>
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {e.patientId ? e.patientId.slice(0, 8) : '—'}
                </td>
                <td className="px-3 py-2 text-right">{e.blockingClaimsCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.recentErasures.length === 0 && (
          <p className="py-4 text-center text-sm text-gray-500">No erasure requests yet.</p>
        )}
      </section>

      {/* Recent consent changes */}
      <section>
        <h2 className="mb-2 text-lg font-semibold">Recent consent changes</h2>
        <p className="mb-2 text-xs text-gray-600">
          {data.consentCounts.granted} granted, {data.consentCounts.withdrawn} withdrawn,{' '}
          {data.consentCounts.expired} expired, {data.consentCounts.superseded} superseded.
        </p>
        <table className="w-full table-auto border-collapse text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left">
              <th className="px-3 py-2">Granted</th>
              <th className="px-3 py-2">Withdrawn</th>
              <th className="px-3 py-2">Patient</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.recentConsentChanges.map((c) => (
              <tr key={c.id} className="border-b">
                <td className="px-3 py-2 text-xs">{new Date(c.grantedAt).toLocaleString()}</td>
                <td className="px-3 py-2 text-xs">
                  {c.withdrawnAt ? new Date(c.withdrawnAt).toLocaleString() : '—'}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{c.patientId.slice(0, 8)}</td>
                <td className="px-3 py-2 font-mono text-xs">{c.consentType}</td>
                <td className="px-3 py-2">
                  <ConsentBadge status={c.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.recentConsentChanges.length === 0 && (
          <p className="py-4 text-center text-sm text-gray-500">No consent records yet.</p>
        )}
      </section>
    </div>
  );
}

interface CardProps {
  title: string;
  value: number;
  accent: 'red' | 'amber' | 'green' | 'gray';
}

function Card({ title, value, accent }: CardProps): JSX.Element {
  const accents: Record<CardProps['accent'], string> = {
    red: 'bg-red-50 text-red-800 border-red-200',
    amber: 'bg-amber-50 text-amber-800 border-amber-200',
    green: 'bg-green-50 text-green-800 border-green-200',
    gray: 'bg-gray-50 text-gray-700 border-gray-200',
  };
  return (
    <div className={`rounded border p-4 ${accents[accent]}`}>
      <p className="text-xs uppercase tracking-wide">{title}</p>
      <p className="mt-1 text-3xl font-semibold">{value.toLocaleString()}</p>
    </div>
  );
}

function ConsentBadge({ status }: { status: string }): JSX.Element {
  const cls =
    status === 'granted'
      ? 'bg-green-100 text-green-800'
      : status === 'withdrawn'
        ? 'bg-amber-100 text-amber-800'
        : status === 'unbound'
          ? 'bg-gray-200 text-gray-700'
          : 'bg-gray-100 text-gray-700';
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-mono ${cls}`}>{status}</span>
  );
}
