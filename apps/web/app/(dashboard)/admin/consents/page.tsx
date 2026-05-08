'use client';

// Slice BT — DPDP consent record viewer.
//
// Operator-facing list of consent records, filterable by patient,
// type, and status. Admins with consent.manage can withdraw an
// active grant inline (prompting for the required reason). New
// grants are captured at admission via a dedicated intake flow
// (out of scope for v1 — this page is the audit + lifecycle surface).

import {
  type ConsentListFilter,
  type ConsentRecordRow,
  type ConsentStatus,
  type ConsentType,
} from '@claims/contracts';
import { useEffect, useState } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { ConsentApi } from '../../../../lib/api/consent.api';

const TYPES: ConsentType[] = [
  'nhcx_processing',
  'pmjay_processing',
  'analytics',
  'communication',
];

const STATUSES: ConsentStatus[] = ['granted', 'withdrawn', 'expired', 'superseded'];

export default function ConsentsViewerPage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const [filter, setFilter] = useState<ConsentListFilter>({});
  const [draft, setDraft] = useState<ConsentListFilter>({});
  const [rows, setRows] = useState<ConsentRecordRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    ConsentApi.list(filter)
      .then((out) => {
        if (cancelled) return;
        setRows(out.rows);
        setTotal(out.total);
      })
      .catch((err) => showApiError(err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filter, refreshKey, showApiError]);

  const apply = (): void => {
    setFilter(draft);
  };

  const withdraw = async (id: string): Promise<void> => {
    const reason = window.prompt(
      'Reason for withdrawing this consent (required, min 5 chars):',
    );
    if (!reason || reason.length < 5) return;
    try {
      await ConsentApi.withdraw(id, { reason });
      setRefreshKey((k) => k + 1);
    } catch (err) {
      showApiError(err);
    }
  };

  return (
    <div className="space-y-4 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Consent records</h1>
        <span className="text-sm text-gray-600">
          DPDP Act 2023 §6 / Rule 8 — operator-captured grants and withdrawals
        </span>
      </header>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <input
          type="text"
          placeholder="Patient id (uuid)"
          value={draft.patientId ?? ''}
          onChange={(e) => setDraft({ ...draft, patientId: e.target.value || undefined })}
          className="rounded border px-3 py-2"
        />
        <select
          value={draft.consentType ?? ''}
          onChange={(e) =>
            setDraft({
              ...draft,
              consentType: (e.target.value || undefined) as ConsentType | undefined,
            })
          }
          className="rounded border px-3 py-2"
        >
          <option value="">All types</option>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          value={draft.status ?? ''}
          onChange={(e) =>
            setDraft({
              ...draft,
              status: (e.target.value || undefined) as ConsentStatus | undefined,
            })
          }
          className="rounded border px-3 py-2"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={apply}
          className="rounded bg-gray-800 px-4 py-2 text-white hover:bg-gray-900"
        >
          Apply filter
        </button>
      </section>

      <section>
        <table className="w-full table-auto border-collapse text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left">
              <th className="px-3 py-2">Granted</th>
              <th className="px-3 py-2">Patient</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Lawful basis</th>
              <th className="px-3 py-2">Source</th>
              <th className="px-3 py-2">Expires</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b hover:bg-gray-50">
                <td className="px-3 py-2">{new Date(r.grantedAt).toLocaleString()}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.patientId.slice(0, 8)}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.consentType}</td>
                <td className="px-3 py-2">
                  <span
                    className={
                      r.status === 'granted'
                        ? 'rounded bg-green-100 px-2 py-0.5 text-xs text-green-800'
                        : 'rounded bg-gray-200 px-2 py-0.5 text-xs text-gray-700'
                    }
                  >
                    {r.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs">{r.lawfulBasis}</td>
                <td className="px-3 py-2 text-xs">{r.source}</td>
                <td className="px-3 py-2 text-xs">
                  {r.expiresAt ? new Date(r.expiresAt).toLocaleDateString() : '—'}
                </td>
                <td className="px-3 py-2">
                  {r.status === 'granted' && (
                    <button
                      type="button"
                      onClick={() => {
                        void withdraw(r.id);
                      }}
                      className="rounded border border-red-600 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                    >
                      Withdraw
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && !loading && (
          <p className="py-8 text-center text-gray-500">No matching consent records.</p>
        )}
        {loading && <p className="py-8 text-center text-gray-500">Loading…</p>}
      </section>

      <section className="flex items-center justify-between">
        <span className="text-sm text-gray-600">
          Showing {rows.length} of {total}
        </span>
      </section>
    </div>
  );
}
