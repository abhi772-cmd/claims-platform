'use client';

// Slice BU — DPDP / IRDAI / RBI compliance dashboard.
//
// One screen surfacing every compliance signal the operator needs:
//   - Bento stat row (open / notified breaches, active consents,
//     unbound access)
//   - Audit retention class breakdown (rows + past-floor counts)
//   - Open breach incidents with overdue 72h banner + inline notify/dismiss
//   - Recent decrypt events bound to consent grants
//   - Recent erasure requests
//   - Consent rollup + recent grants/withdrawals
//
// Permission: audit.view. Breach notify/dismiss additionally need
// breach_incident.manage; the API gates and the catch surfaces a 403
// via the error modal.

import { type ComplianceDashboard } from '@claims/contracts';
import { useEffect, useState, type ReactNode } from 'react';

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
      // Informational only — toast-equivalent.
      window.alert(`Scan complete: ${r.incidentsCreated} new incident(s) in ${r.durationMs}ms.`);
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
    return (
      <div className="glass max-w-md rounded-xl p-6">
        <p className="text-body text-on-surface-variant">Loading compliance snapshot…</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="glass max-w-md rounded-xl p-6">
        <p className="text-body text-on-surface-variant">No data available.</p>
      </div>
    );
  }

  const overdueOpen = data.openBreaches.filter((b) => b.overdue).length;

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6">
      {/* Header */}
      <header className="glass flex flex-col items-start justify-between gap-4 rounded-xl p-6 md:flex-row md:items-center">
        <div>
          <h2 className="text-h2 font-h2 text-on-surface">Compliance dashboard</h2>
          <p className="mt-1 text-body text-on-surface-variant">
            DPDP Act 2023 + IRDAI 5y + RBI 10y rollup. Snapshot{' '}
            {new Date(data.generatedAt).toLocaleString()}.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={refresh}
            className="btn-outline"
            style={{ padding: '10px 22px', fontSize: '13px' }}
          >
            <span className="material-symbols-outlined text-[18px]">refresh</span>
            Refresh
          </button>
          <button
            type="button"
            onClick={() => void runScan()}
            disabled={scanning}
            className="btn-primary"
            style={{ padding: '10px 22px', fontSize: '13px' }}
          >
            <span
              className="material-symbols-outlined text-[18px]"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              radar
            </span>
            {scanning ? 'Scanning…' : 'Run breach scan'}
          </button>
        </div>
      </header>

      {/* Overdue banner */}
      {overdueOpen > 0 && (
        <section className="rounded-xl border border-error/30 bg-error-container/60 p-4 backdrop-blur-[24px]">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-error/15 text-error">
              <span
                className="material-symbols-outlined"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                priority_high
              </span>
            </div>
            <p className="text-body font-semibold text-error">
              {overdueOpen} open breach incident(s) past the 72-hour DPDP §8(6) notification
              deadline. Notify the Data Protection Board immediately.
            </p>
          </div>
        </section>
      )}

      {/* Bento stat row */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Open breaches"
          value={data.breachCounts.detected}
          tone={data.breachCounts.detected > 0 ? 'danger' : 'neutral'}
          icon="gpp_bad"
        />
        <StatTile
          label="Notified breaches"
          value={data.breachCounts.notified}
          tone={data.breachCounts.notified > 0 ? 'warning' : 'neutral'}
          icon="mark_email_read"
        />
        <StatTile
          label="Active consents"
          value={data.consentCounts.granted}
          tone="success"
          icon="verified_user"
        />
        <StatTile
          label="Unbound access (24h)"
          value={data.unboundAccessCountLast24h}
          tone={data.unboundAccessCountLast24h > 0 ? 'warning' : 'neutral'}
          icon="no_accounts"
        />
      </div>

      {/* Audit retention */}
      <Panel title="Audit retention" icon="schedule">
        <Table head={['Class', 'Total rows', 'Past floor']} alignRight={[1, 2]}>
          {data.retentionClasses.map((r) => (
            <tr key={r.retentionClass} className="transition-colors hover:bg-primary/5">
              <Td mono>{r.retentionClass}</Td>
              <Td right>{r.total.toLocaleString()}</Td>
              <Td right>
                {r.pastFloor > 0 ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-amber-100 bg-amber-50 px-2 py-0.5 text-body-sm font-medium text-amber-700">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                    {r.pastFloor.toLocaleString()}
                  </span>
                ) : (
                  <span className="text-on-surface-variant">0</span>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Panel>

      {/* Open breaches */}
      <Panel title="Open breach incidents" icon="report">
        {data.openBreaches.length === 0 ? (
          <EmptyRow text="No open breach incidents." />
        ) : (
          <Table head={['Opened', 'Kind', 'Severity', 'Affected', 'Due', '']} alignRight={[3]}>
            {data.openBreaches.map((b) => (
              <tr
                key={b.id}
                className={`transition-colors hover:bg-primary/5 ${b.overdue ? 'bg-red-50/60' : ''}`}
              >
                <Td>{new Date(b.openedAt).toLocaleString()}</Td>
                <Td mono>{b.kind}</Td>
                <Td>{b.severity}</Td>
                <Td right>{b.affectedDataPrincipals}</Td>
                <Td>
                  <span className="inline-flex items-center gap-2">
                    {new Date(b.dpdpNotificationDueAt).toLocaleString()}
                    {b.overdue && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold uppercase text-red-700">
                        <span className="h-1 w-1 animate-pulse rounded-full bg-red-500" />
                        Overdue
                      </span>
                    )}
                  </span>
                </Td>
                <Td>
                  <div className="flex justify-end gap-2 whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => void notify(b.id)}
                      className="btn-primary"
                      style={{ padding: '6px 14px', fontSize: '12px' }}
                    >
                      <span className="material-symbols-outlined text-[16px]">send</span>
                      Notify
                    </button>
                    <button
                      type="button"
                      onClick={() => void dismiss(b.id)}
                      className="btn-outline"
                      style={{ padding: '6px 14px', fontSize: '12px' }}
                    >
                      Dismiss
                    </button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>

      {/* Recent decrypt events */}
      <Panel title="Recent decrypt events" icon="lock_open">
        {data.recentDataAccess.length === 0 ? (
          <EmptyRow text="No recent decrypt events." />
        ) : (
          <Table head={['Time', 'Actor', 'Resource', 'Fields', 'Purpose', 'Consent']}>
            {data.recentDataAccess.map((e) => (
              <tr key={e.id} className="transition-colors hover:bg-primary/5">
                <Td>{new Date(e.occurredAt).toLocaleString()}</Td>
                <Td mono>
                  {e.actorUserId ? `${e.actorType}:${e.actorUserId.slice(0, 8)}` : e.actorType}
                </Td>
                <Td mono>
                  {e.resourceType}
                  {e.resourceId ? ` / ${e.resourceId.slice(0, 8)}` : ''}
                </Td>
                <Td mono>{e.fieldNames?.join(', ') ?? '—'}</Td>
                <Td mono>{e.purpose}</Td>
                <Td>
                  <ConsentBadge status={e.consentStatus} />
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>

      {/* Recent erasures */}
      <Panel
        title="Recent erasure requests"
        icon="delete_sweep"
        subtitle={`Last 90 days: ${data.erasureCounts.completed} completed, ${data.erasureCounts.rejected} rejected.`}
      >
        {data.recentErasures.length === 0 ? (
          <EmptyRow text="No erasure requests yet." />
        ) : (
          <Table head={['Filed', 'Status', 'Patient', 'Blocking claims']} alignRight={[3]}>
            {data.recentErasures.map((e) => (
              <tr key={e.id} className="transition-colors hover:bg-primary/5">
                <Td>{new Date(e.createdAt).toLocaleString()}</Td>
                <Td>
                  <span
                    className={
                      e.status === 'completed'
                        ? 'inline-flex items-center gap-1.5 rounded-full border border-green-100 bg-green-50 px-2.5 py-1 text-body-sm font-medium text-green-700'
                        : 'inline-flex items-center gap-1.5 rounded-full border border-amber-100 bg-amber-50 px-2.5 py-1 text-body-sm font-medium text-amber-700'
                    }
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${e.status === 'completed' ? 'bg-green-500' : 'bg-amber-500'}`}
                    />
                    {e.status}
                  </span>
                </Td>
                <Td mono>{e.patientId ? e.patientId.slice(0, 8) : '—'}</Td>
                <Td right>{e.blockingClaimsCount}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>

      {/* Recent consent changes */}
      <Panel
        title="Recent consent changes"
        icon="task_alt"
        subtitle={`${data.consentCounts.granted} granted, ${data.consentCounts.withdrawn} withdrawn, ${data.consentCounts.expired} expired, ${data.consentCounts.superseded} superseded.`}
      >
        {data.recentConsentChanges.length === 0 ? (
          <EmptyRow text="No consent records yet." />
        ) : (
          <Table head={['Granted', 'Withdrawn', 'Patient', 'Type', 'Status']}>
            {data.recentConsentChanges.map((c) => (
              <tr key={c.id} className="transition-colors hover:bg-primary/5">
                <Td>{new Date(c.grantedAt).toLocaleString()}</Td>
                <Td>{c.withdrawnAt ? new Date(c.withdrawnAt).toLocaleString() : '—'}</Td>
                <Td mono>{c.patientId.slice(0, 8)}</Td>
                <Td mono>{c.consentType}</Td>
                <Td>
                  <ConsentBadge status={c.status} />
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </div>
  );
}

// -----------------------------------------------------------------------------
// shared bits
// -----------------------------------------------------------------------------

interface StatTileProps {
  label: string;
  value: number;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
  icon: string;
}
function StatTile({ label, value, tone, icon }: StatTileProps): JSX.Element {
  const t: Record<
    StatTileProps['tone'],
    { dot: string; text: string; icBg: string; icFg: string; valueText: string }
  > = {
    success: {
      dot: 'bg-primary',
      text: 'text-primary',
      icBg: 'bg-primary-fixed-dim/30',
      icFg: 'text-primary',
      valueText: 'text-on-surface',
    },
    warning: {
      dot: 'bg-secondary-container',
      text: 'text-secondary',
      icBg: 'bg-secondary-fixed/50',
      icFg: 'text-secondary',
      valueText: 'text-on-surface',
    },
    danger: {
      dot: 'bg-error',
      text: 'text-error',
      icBg: 'bg-error-container/50',
      icFg: 'text-error',
      valueText: 'text-on-surface',
    },
    neutral: {
      dot: 'bg-outline',
      text: 'text-outline',
      icBg: 'bg-surface-variant/40',
      icFg: 'text-outline',
      valueText: 'text-on-surface',
    },
  };
  const s = t[tone];
  return (
    <div className="glass flex h-full flex-col rounded-xl p-6">
      <div className="mb-4 flex items-start justify-between">
        <span
          className={`flex items-center gap-1 text-eyebrow uppercase tracking-eyebrow ${s.text}`}
        >
          <span className={`h-2 w-2 animate-pulse rounded-full ${s.dot}`} />
          Live
        </span>
        <div
          className={`flex h-8 w-8 items-center justify-center rounded-full border border-white/50 ${s.icBg} ${s.icFg}`}
        >
          <span className="material-symbols-outlined text-[18px]">{icon}</span>
        </div>
      </div>
      <h3 className="mb-1 text-body-sm text-on-surface-variant">{label}</h3>
      <div className={`text-h2 font-h2 tabular-nums ${s.valueText}`}>
        {value.toString().padStart(2, '0')}
      </div>
    </div>
  );
}

function Panel({
  title,
  subtitle,
  icon,
  children,
}: {
  title: string;
  subtitle?: string;
  icon?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="glass flex flex-col overflow-hidden rounded-xl">
      <div className="border-b border-surface-variant/50 bg-white/30 px-6 py-4">
        <div className="flex items-center gap-2">
          {icon ? (
            <span className="material-symbols-outlined text-primary">{icon}</span>
          ) : null}
          <h3 className="text-body font-semibold text-on-surface">{title}</h3>
        </div>
        {subtitle ? (
          <p className="mt-1 text-body-sm text-on-surface-variant">{subtitle}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Table({
  head,
  alignRight = [],
  children,
}: {
  head: string[];
  alignRight?: number[];
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead className="bg-primary/5">
          <tr>
            {head.map((h, i) => (
              <th
                key={i}
                className={`px-6 py-3 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant ${alignRight.includes(i) ? 'text-right' : ''}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-surface-variant/30">{children}</tbody>
      </table>
    </div>
  );
}

function Td({
  children,
  mono = false,
  right = false,
}: {
  children: ReactNode;
  mono?: boolean;
  right?: boolean;
}): JSX.Element {
  return (
    <td
      className={`px-6 py-3 text-body-sm text-on-surface ${mono ? 'font-mono' : ''} ${right ? 'text-right' : ''}`}
    >
      {children}
    </td>
  );
}

function EmptyRow({ text }: { text: string }): JSX.Element {
  return (
    <p className="px-6 py-10 text-center text-body-sm text-on-surface-variant">{text}</p>
  );
}

function ConsentBadge({ status }: { status: string }): JSX.Element {
  const { cls, dot } =
    status === 'granted'
      ? { cls: 'bg-green-50 text-green-700 border-green-100', dot: 'bg-green-500' }
      : status === 'withdrawn'
        ? { cls: 'bg-amber-50 text-amber-700 border-amber-100', dot: 'bg-amber-500' }
        : status === 'unbound'
          ? { cls: 'bg-red-50 text-red-700 border-red-100', dot: 'bg-red-500' }
          : { cls: 'bg-surface-container text-on-surface-variant border-outline-variant/50', dot: 'bg-outline' };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-body-sm font-medium ${cls}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {status}
    </span>
  );
}
