'use client';

// Payer commercial terms — onboarding step page.
//
// Lists every active payer with a completeness indicator across
// (a) room rate overrides per active category, (b) the mandatory
// commercial terms (co-pay + deductible). Clicking a row opens a
// slide-over drawer where the admin fills the room rate matrix and
// the three-tab terms form for that payer. Bottom CTA `Mark step
// complete` activates only when every active payer is fully
// configured.

import {
  type PayerOnboardingStatus,
  type PayerOnboardingStatusResponse,
  type RoomCategory,
} from '@claims/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { PayerDrawer } from './PayerDrawer';
import { useErrorModal } from '../../../../../components/modals/ErrorModal/ErrorModalProvider';
import { LoadingShimmer } from '../../../../../components/ui/LoadingShimmer';
import { useToast } from '../../../../../components/toast/ToastProvider';
import { PayerCommercialTermsApi } from '../../../../../lib/api/payer-commercial-terms.api';
import { RoomCategoryApi } from '../../../../../lib/api/room-category.api';
import { TenantApi } from '../../../../../lib/api/tenant.api';

export default function PayerCommercialTermsPage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const showToast = useToast();
  const [status, setStatus] = useState<PayerOnboardingStatusResponse | null>(null);
  const [categories, setCategories] = useState<RoomCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [openPayer, setOpenPayer] = useState<PayerOnboardingStatus | null>(null);
  const [markingComplete, setMarkingComplete] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [s, c] = await Promise.all([
        PayerCommercialTermsApi.status(),
        RoomCategoryApi.listAdmin(),
      ]);
      setStatus(s);
      setCategories(c.categories);
    } catch (err) {
      showApiError(err);
    } finally {
      setLoading(false);
    }
  }, [showApiError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onMarkStepComplete(): Promise<void> {
    setMarkingComplete(true);
    try {
      await TenantApi.completeOnboardingStep('payer_commercial_terms', {
        status: 'completed',
      });
      showToast({ tone: 'success', message: 'Step marked complete.' });
    } catch (err) {
      showApiError(err);
    } finally {
      setMarkingComplete(false);
    }
  }

  if (loading) {
    return <LoadingShimmer variant="page" label="Loading commercial terms" />;
  }
  if (!status) return <></>;

  const completeCount = status.payers.filter((p) => p.fullyComplete).length;
  const totalCount = status.payers.length;
  const activeCategoriesCount = categories.filter((c) => c.active).length;

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-body-sm text-on-surface-variant">
            <Link href="/admin/onboarding" className="hover:text-primary">
              Onboarding
            </Link>
            <span>/</span>
            <span className="text-on-surface">Payer commercial terms</span>
          </div>
          <h2 className="mt-1 text-h2 font-h2 text-primary">Payer commercial terms</h2>
          <p className="mt-1 max-w-2xl text-body text-on-surface-variant">
            Capture room rates, co-pay and deductible for every active payer. These
            drive the room-rate dropdown on intake, the out-of-pocket pre-warn,
            and (later) variance detection on settlement.
          </p>
        </div>
      </div>

      {/* Status banner */}
      <div className="glass rounded-xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
              Step status
            </span>
            <div className="flex items-baseline gap-3">
              <span className="text-h2 font-h2 tabular-nums text-on-surface">
                {completeCount}
                <span className="text-h3 text-on-surface-variant"> / {totalCount}</span>
              </span>
              <span className="text-body text-on-surface-variant">
                payer{totalCount === 1 ? '' : 's'} fully configured
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-body-sm text-on-surface-variant">
              <span className="material-symbols-outlined text-[18px] text-primary">
                bed
              </span>
              <span>
                {activeCategoriesCount} active room categor
                {activeCategoriesCount === 1 ? 'y' : 'ies'} in your catalog
              </span>
              <Link
                href="/admin/room-categories"
                className="ml-2 text-primary hover:underline"
              >
                Manage catalog →
              </Link>
            </div>
          </div>
          <button
            type="button"
            disabled={!status.allPayersComplete || markingComplete}
            onClick={() => void onMarkStepComplete()}
            className="btn-cta disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {markingComplete ? 'Saving…' : 'Mark step complete'}
            <span
              className="material-symbols-outlined ml-2 text-[18px]"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              check
            </span>
          </button>
        </div>
      </div>

      {/* Payer table */}
      <div className="glass overflow-hidden rounded-xl">
        <table className="w-full text-left">
          <thead className="border-b border-outline-variant/40 bg-surface-container-lowest/50 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
            <tr>
              <th className="px-5 py-3">Payer</th>
              <th className="px-5 py-3">Status</th>
              <th className="px-5 py-3">Room rates</th>
              <th className="px-5 py-3">Commercial terms</th>
              <th className="px-5 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {status.payers.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-body-sm text-on-surface-variant">
                  No active payers yet. Add at least one payer to the master
                  before configuring commercial terms.
                </td>
              </tr>
            ) : (
              status.payers.map((p) => (
                <tr
                  key={p.payerCode}
                  className="border-b border-outline-variant/30 last:border-b-0 transition-colors hover:bg-primary-fixed/5"
                >
                  <td className="px-5 py-4">
                    <div className="font-medium text-on-surface">{p.payerName}</div>
                    <div className="font-mono text-[12px] text-on-surface-variant">
                      {p.payerCode}
                    </div>
                  </td>
                  <td className="px-5 py-4">
                    <StatusDot
                      tone={p.fullyComplete ? 'success' : 'warning'}
                      label={p.fullyComplete ? 'Complete' : 'Incomplete'}
                    />
                  </td>
                  <td className="px-5 py-4 text-body-sm tabular-nums text-on-surface">
                    {p.roomRatesFilled} of {p.roomRatesTotal}
                  </td>
                  <td className="px-5 py-4">
                    <StatusDot
                      tone={p.termsMandatoryComplete ? 'success' : 'warning'}
                      label={
                        p.termsMandatoryComplete
                          ? 'Co-pay + deductible set'
                          : 'Mandatory fields pending'
                      }
                    />
                  </td>
                  <td className="px-5 py-4 text-right">
                    <button
                      type="button"
                      onClick={() => setOpenPayer(p)}
                      className="text-body-sm font-semibold text-primary hover:underline"
                    >
                      {p.fullyComplete ? 'Edit' : 'Configure'} →
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Drawer */}
      {openPayer ? (
        <PayerDrawer
          payerCode={openPayer.payerCode}
          payerName={openPayer.payerName}
          categories={categories.filter((c) => c.active)}
          onClose={() => setOpenPayer(null)}
          onSaved={async () => {
            await refresh();
            showToast({ tone: 'success', message: 'Commercial terms saved.' });
          }}
        />
      ) : null}
    </div>
  );
}

function StatusDot({
  tone,
  label,
}: {
  tone: 'success' | 'warning' | 'danger';
  label: string;
}): JSX.Element {
  const dotCls =
    tone === 'success'
      ? 'bg-primary'
      : tone === 'warning'
        ? 'bg-secondary'
        : 'bg-error';
  return (
    <span className="inline-flex items-center gap-2 text-body-sm text-on-surface">
      <span className={`h-2 w-2 rounded-full ${dotCls}`} />
      {label}
    </span>
  );
}
