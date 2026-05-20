'use client';

// Payers you work with — onboarding empanelment step (and standing
// admin surface). The tenant picks which registry payers/TPAs the
// hospital is tied up with; the empanelled set drives the payer
// dropdown on case creation.
//
// The registry itself is superadmin-curated (read-only here). If a
// payer the hospital deals with isn't in the registry, the tenant
// asks DigiSparsh to add it — they can't add it themselves.

import {
  type AvailablePayer,
  type PayerType,
} from '@claims/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { useErrorModal } from '../../../../../components/modals/ErrorModal/ErrorModalProvider';
import { useToast } from '../../../../../components/toast/ToastProvider';
import { LoadingShimmer } from '../../../../../components/ui/LoadingShimmer';
import { TenantApi } from '../../../../../lib/api/tenant.api';
import { TenantPayerApi } from '../../../../../lib/api/tenant-payer.api';

const TYPE_LABEL: Record<PayerType, string> = {
  private_tpa: 'Private TPA',
  private_insurer: 'Private insurer',
  pmjay_sha: 'PMJAY SHA',
  cghs: 'CGHS',
  self: 'Self-pay',
};

export default function PayerEmpanelmentPage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const showToast = useToast();
  const [rows, setRows] = useState<AvailablePayer[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await TenantPayerApi.listAvailable();
      setRows(res.payers);
    } catch (err) {
      showApiError(err);
    }
  }, [showApiError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const empanelledCount = (rows ?? []).filter((r) => r.empanelledActive).length;

  async function toggle(row: AvailablePayer): Promise<void> {
    setBusyId(row.payerId);
    try {
      if (!row.empanelled) {
        await TenantPayerApi.empanel(row.payerId);
      } else {
        await TenantPayerApi.setActive(row.payerId, !row.empanelledActive);
      }
      await refresh();
    } catch (err) {
      showApiError(err);
    } finally {
      setBusyId(null);
    }
  }

  async function onMarkComplete(): Promise<void> {
    setMarking(true);
    try {
      await TenantApi.completeOnboardingStep('payer_master', { status: 'completed' });
      showToast({ tone: 'success', message: 'Empanelment step marked complete.' });
    } catch (err) {
      showApiError(err);
    } finally {
      setMarking(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/onboarding" className="text-body-sm text-primary hover:underline">
          ← Back to onboarding
        </Link>
        <h1 className="mt-2 text-h1 font-h1 text-on-surface">Payers you work with</h1>
        <p className="mt-1 max-w-2xl text-body text-on-surface-variant">
          Select the insurers, TPAs, and PMJAY agencies your hospital is tied up
          with. Only the payers you empanel here appear in the dropdown when
          your team creates a case. The list of available payers is curated by
          DigiSparsh — if one you deal with is missing, ask us to add it.
        </p>
      </div>

      <div className="glass rounded-xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
              Empanelled
            </span>
            <div className="flex items-baseline gap-3">
              <span className="text-h2 font-h2 tabular-nums text-on-surface">
                {empanelledCount}
              </span>
              <span className="text-body text-on-surface-variant">
                payer{empanelledCount === 1 ? '' : 's'} active for case creation
              </span>
            </div>
          </div>
          <button
            type="button"
            disabled={empanelledCount === 0 || marking}
            onClick={() => void onMarkComplete()}
            className="btn-cta disabled:cursor-not-allowed disabled:opacity-40"
          >
            {marking ? 'Saving…' : 'Mark step complete'}
          </button>
        </div>
      </div>

      <div className="glass overflow-hidden rounded-xl">
        <table className="w-full text-left">
          <thead className="border-b border-outline-variant/40 bg-surface-container-lowest/50 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
            <tr>
              <th className="px-5 py-3">Payer</th>
              <th className="px-5 py-3">Type</th>
              <th className="px-5 py-3">Rail</th>
              <th className="px-5 py-3">NHCX code</th>
              <th className="px-5 py-3 text-right">Empanel</th>
            </tr>
          </thead>
          <tbody>
            {rows === null ? (
              <tr>
                <td colSpan={5} className="px-5 py-6">
                  <LoadingShimmer variant="row" label="Loading payers" />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-body-sm text-on-surface-variant">
                  No payers in the registry yet. Ask DigiSparsh to add the
                  insurers / TPAs you deal with.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.payerId} className="border-b border-outline-variant/20">
                  <td className="px-5 py-4">
                    <div className="text-body text-on-surface">{r.name}</div>
                    <div className="font-mono text-body-sm text-on-surface-variant">{r.code}</div>
                  </td>
                  <td className="px-5 py-4 text-body-sm text-on-surface-variant">
                    {TYPE_LABEL[r.payerType]}
                  </td>
                  <td className="px-5 py-4 text-body-sm uppercase text-on-surface-variant">
                    {r.rail}
                  </td>
                  <td className="px-5 py-4 font-mono text-body-sm">
                    {r.hcxCode ? (
                      <span className="text-on-surface">{r.hcxCode}</span>
                    ) : (
                      <span className="rounded bg-error/10 px-2 py-0.5 text-error">missing</span>
                    )}
                  </td>
                  <td className="px-5 py-4 text-right">
                    <label className="inline-flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={r.empanelledActive}
                        disabled={busyId === r.payerId}
                        onChange={() => void toggle(r)}
                        className="h-5 w-5"
                      />
                      <span className="text-body-sm text-on-surface-variant">
                        {r.empanelledActive
                          ? 'Tied up'
                          : r.empanelled
                            ? 'Retired'
                            : 'Not selected'}
                      </span>
                    </label>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
