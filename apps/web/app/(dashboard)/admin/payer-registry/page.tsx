'use client';

// HCX payer registry — DigiSparsh superadmin (platform_admin) surface.
//
// The platform-curated master of NHCX-integrated insurers / TPAs /
// SHAs, each mapped to its @hcx participant code. Superadmin maintains
// this centrally because NHCX codes are national — one source of
// truth. Tenants do NOT edit this; they empanel (tie up with) registry
// payers via the onboarding "Payers you work with" step, and those
// drive the case-creation dropdown.
//
// Mutations are gated server-side by payer.master.edit (platform_admin
// only). Tenants reaching this page get 403 on save.

import {
  type CreatePayerRequest,
  type Payer,
  type PayerRail,
  type PayerType,
} from '@claims/contracts';
import { useCallback, useEffect, useState } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { useToast } from '../../../../components/toast/ToastProvider';
import { LoadingShimmer } from '../../../../components/ui/LoadingShimmer';
import { MasterDataApi } from '../../../../lib/api/master-data.api';

const PAYER_TYPES: Array<{ value: PayerType; label: string }> = [
  { value: 'private_tpa', label: 'Private TPA' },
  { value: 'private_insurer', label: 'Private insurer' },
  { value: 'pmjay_sha', label: 'PMJAY State Health Agency' },
  { value: 'cghs', label: 'CGHS' },
  { value: 'self', label: 'Self-pay' },
];

const RAILS: Array<{ value: PayerRail; label: string }> = [
  { value: 'nhcx', label: 'NHCX (private cashless)' },
  { value: 'pmjay', label: 'PMJAY' },
  { value: 'self_pay', label: 'Self-pay' },
];

export default function PayerRegistryPage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const showToast = useToast();
  const [payers, setPayers] = useState<Payer[] | null>(null);
  const [editing, setEditing] = useState<Payer | 'new' | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await MasterDataApi.listPayers({ limit: 200 });
      setPayers(res.payers);
    } catch (err) {
      showApiError(err);
    }
  }, [showApiError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const railBound = (payers ?? []).filter((p) => p.rail !== 'self_pay');
  const missingHcx = railBound.filter((p) => !p.hcxCode);

  return (
    <div className="space-y-6">
      <div>
        <span className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
          Superadmin
        </span>
        <h1 className="mt-1 text-h1 font-h1 text-on-surface">HCX payer registry</h1>
        <p className="mt-1 max-w-2xl text-body text-on-surface-variant">
          The platform-wide master of NHCX-integrated insurers, TPAs, and PMJAY
          State Health Agencies, each mapped to its NHCX participant code.
          Hospitals pick from this registry when they empanel — they don&apos;t
          edit it. Codes are national, so this is the single source of truth.
        </p>
      </div>

      <div className="glass rounded-xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
              Registry
            </span>
            <div className="flex items-baseline gap-3">
              <span className="text-h2 font-h2 tabular-nums text-on-surface">
                {payers?.length ?? 0}
              </span>
              <span className="text-body text-on-surface-variant">
                payer{(payers?.length ?? 0) === 1 ? '' : 's'} registered
                {missingHcx.length > 0 ? ` · ${missingHcx.length} missing NHCX code` : ''}
              </span>
            </div>
          </div>
          <button type="button" onClick={() => setEditing('new')} className="btn-cta">
            + Add payer
          </button>
        </div>
      </div>

      <div className="glass overflow-hidden rounded-xl">
        <table className="w-full text-left">
          <thead className="border-b border-outline-variant/40 bg-surface-container-lowest/50 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
            <tr>
              <th className="px-5 py-3">Code</th>
              <th className="px-5 py-3">Name</th>
              <th className="px-5 py-3">Type</th>
              <th className="px-5 py-3">Rail</th>
              <th className="px-5 py-3">NHCX participant code</th>
              <th className="px-5 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {payers === null ? (
              <tr>
                <td colSpan={6} className="px-5 py-6">
                  <LoadingShimmer variant="row" label="Loading payers" />
                </td>
              </tr>
            ) : payers.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-5 py-8 text-center text-body-sm text-on-surface-variant">
                  No payers in the registry yet. Add the NHCX-integrated
                  insurers / TPAs / SHAs.
                </td>
              </tr>
            ) : (
              payers.map((p) => (
                <tr key={p.id} className="border-b border-outline-variant/20">
                  <td className="px-5 py-4 font-mono text-body-sm text-on-surface">{p.code}</td>
                  <td className="px-5 py-4 text-body text-on-surface">{p.name}</td>
                  <td className="px-5 py-4 text-body-sm text-on-surface-variant">
                    {PAYER_TYPES.find((t) => t.value === p.payerType)?.label ?? p.payerType}
                  </td>
                  <td className="px-5 py-4 text-body-sm uppercase text-on-surface-variant">
                    {p.rail}
                  </td>
                  <td className="px-5 py-4 font-mono text-body-sm">
                    {p.hcxCode ? (
                      <span className="text-on-surface">{p.hcxCode}</span>
                    ) : p.rail === 'self_pay' ? (
                      <span className="text-on-surface-variant">—</span>
                    ) : (
                      <span className="rounded bg-error/10 px-2 py-0.5 text-error">missing</span>
                    )}
                  </td>
                  <td className="px-5 py-4 text-right">
                    <button
                      type="button"
                      onClick={() => setEditing(p)}
                      className="text-body-sm font-semibold text-primary hover:underline"
                    >
                      Edit →
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {editing ? (
        <PayerForm
          payer={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
            showToast({ tone: 'success', message: 'Payer saved.' });
          }}
        />
      ) : null}
    </div>
  );
}

function PayerForm({
  payer,
  onClose,
  onSaved,
}: {
  payer: Payer | null;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const { showApiError } = useErrorModal();
  const isEdit = payer !== null;
  const [code, setCode] = useState(payer?.code ?? '');
  const [name, setName] = useState(payer?.name ?? '');
  const [payerType, setPayerType] = useState<PayerType>(payer?.payerType ?? 'private_tpa');
  const [rail, setRail] = useState<PayerRail>(payer?.rail ?? 'nhcx');
  const [hcxCode, setHcxCode] = useState(payer?.hcxCode ?? '');
  const [active, setActive] = useState(payer?.active ?? true);
  const [saving, setSaving] = useState(false);

  async function onSubmit(): Promise<void> {
    setSaving(true);
    try {
      if (isEdit && payer) {
        await MasterDataApi.updatePayer(payer.id, {
          name,
          payerType,
          rail,
          hcxCode: hcxCode.trim() ? hcxCode.trim() : null,
          active,
        });
      } else {
        const body: CreatePayerRequest = {
          code: code.trim().toUpperCase(),
          name: name.trim(),
          payerType,
          rail,
          ...(hcxCode.trim() ? { hcxCode: hcxCode.trim() } : {}),
        };
        await MasterDataApi.createPayer(body);
      }
      onSaved();
    } catch (err) {
      showApiError(err);
    } finally {
      setSaving(false);
    }
  }

  const railNeedsHcx = rail !== 'self_pay';

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-on-surface/40 backdrop-blur-sm">
      <div className="glass-strong w-[min(560px,calc(100%-32px))] rounded-xl p-6">
        <h3 className="mb-1 text-h3 font-h3 text-on-surface">
          {isEdit ? `Edit ${payer.name}` : 'Add payer to registry'}
        </h3>
        <p className="mb-4 text-body-sm text-on-surface-variant">
          {isEdit
            ? 'Update the payer details or its NHCX participant code.'
            : 'Register a new NHCX-integrated insurer / TPA / SHA. The code is a stable internal handle; the NHCX participant code is what routes claims on the gateway.'}
        </p>

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
              Code (UPPER_SNAKE)
            </label>
            <input
              value={code}
              disabled={isEdit}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
              placeholder="STAR_HEALTH"
              className="glass-input font-mono disabled:opacity-50"
            />
            {isEdit ? (
              <p className="mt-1 text-body-sm text-on-surface-variant">
                Code is immutable once created.
              </p>
            ) : null}
          </div>

          <div>
            <label className="mb-1 block text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Star Health & Allied Insurance"
              className="glass-input"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                Type
              </label>
              <select
                value={payerType}
                onChange={(e) => setPayerType(e.target.value as PayerType)}
                className="glass-input"
              >
                {PAYER_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                Rail
              </label>
              <select
                value={rail}
                onChange={(e) => setRail(e.target.value as PayerRail)}
                className="glass-input"
              >
                {RAILS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
              NHCX participant code {railNeedsHcx ? '' : '(not needed for self-pay)'}
            </label>
            <input
              value={hcxCode}
              onChange={(e) => setHcxCode(e.target.value.trim())}
              placeholder={rail === 'pmjay' ? 'pmjay@hcx' : 'starhealth@hcx'}
              disabled={!railNeedsHcx}
              className="glass-input font-mono disabled:opacity-50"
            />
            <p className="mt-1 text-body-sm text-on-surface-variant">
              The payer&apos;s handle on the NHCX gateway, from the NHCX
              participant registry or the payer&apos;s onboarding pack.
            </p>
          </div>

          {isEdit ? (
            <label className="flex cursor-pointer items-center gap-2 text-body text-on-surface">
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
                className="h-4 w-4"
              />
              Active (uncheck to retire without deleting history)
            </label>
          ) : null}
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={onClose} className="btn-outline">
            Cancel
          </button>
          <button
            type="button"
            disabled={saving || !name.trim() || (!isEdit && code.trim().length < 2)}
            onClick={() => void onSubmit()}
            className="btn-cta disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add payer'}
          </button>
        </div>
      </div>
    </div>
  );
}
