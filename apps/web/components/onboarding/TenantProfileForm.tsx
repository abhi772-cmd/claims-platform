'use client';

import {
  type ExpectedMonthlyClaimsBand,
  type HospitalType,
  type TenantProfile,
} from '@claims/contracts';
import { useEffect, useState, type FormEvent } from 'react';

import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';
import { TenantApi } from '../../lib/api/tenant.api';

const HOSPITAL_TYPE_LABELS: Record<HospitalType, string> = {
  private: 'Private',
  trust: 'Trust',
  government: 'Government',
  psu: 'PSU',
};

const CLAIMS_BAND_LABELS: Record<ExpectedMonthlyClaimsBand, string> = {
  lt_100: 'Under 100 / month',
  band_100_500: '100 – 500 / month',
  band_500_2000: '500 – 2,000 / month',
  gt_2000: 'Over 2,000 / month',
};

// Renders the Stage-1 profile capture form inline inside the
// `tenant_profile` onboarding step. On save: PATCHes /tenant/profile,
// and when every field is filled in, signals the parent to mark the
// step complete. Empty strings on the form map to `null` on the wire.
export function TenantProfileForm({
  onSavedComplete,
}: {
  onSavedComplete: () => void;
}): JSX.Element {
  const { showApiError } = useErrorModal();
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [legalName, setLegalName] = useState('');
  const [rohiniId, setRohiniId] = useState('');
  const [hospitalType, setHospitalType] = useState<HospitalType | ''>('');
  const [bedCount, setBedCount] = useState('');
  const [hmisVendor, setHmisVendor] = useState('');
  const [claimsBand, setClaimsBand] = useState<ExpectedMonthlyClaimsBand | ''>('');

  useEffect(() => {
    let cancelled = false;
    TenantApi.getProfile()
      .then((p) => {
        if (cancelled) return;
        setLegalName(p.legalName ?? '');
        setRohiniId(p.rohiniId ?? '');
        setHospitalType(p.hospitalType ?? '');
        setBedCount(p.bedCount !== null ? String(p.bedCount) : '');
        setHmisVendor(p.hmisVendor ?? '');
        setClaimsBand(p.expectedMonthlyClaimsBand ?? '');
      })
      .catch((err: unknown) => {
        if (!cancelled) showApiError(err);
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [showApiError]);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSaving(true);
    try {
      const trimmedRohini = rohiniId.trim();
      const trimmedBeds = bedCount.trim();
      const trimmedLegal = legalName.trim();
      const trimmedHmis = hmisVendor.trim();
      const patch = {
        legalName: trimmedLegal ? trimmedLegal : null,
        rohiniId: trimmedRohini ? trimmedRohini : null,
        hospitalType: hospitalType === '' ? null : hospitalType,
        bedCount: trimmedBeds ? Number(trimmedBeds) : null,
        hmisVendor: trimmedHmis ? trimmedHmis : null,
        expectedMonthlyClaimsBand: claimsBand === '' ? null : claimsBand,
      } satisfies Partial<TenantProfile>;
      const next = await TenantApi.patchProfile(patch);
      const allFilled =
        next.legalName !== null &&
        next.rohiniId !== null &&
        next.hospitalType !== null &&
        next.bedCount !== null &&
        next.hmisVendor !== null &&
        next.expectedMonthlyClaimsBand !== null;
      if (allFilled) onSavedComplete();
    } catch (err) {
      showApiError(err);
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) {
    return <p className="text-body-sm text-on-surface-variant">Loading profile…</p>;
  }

  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Legal name">
        <input
          type="text"
          value={legalName}
          onChange={(e) => setLegalName(e.target.value)}
          maxLength={256}
          className="glass-input glass-input--sm"
        />
      </Field>
      <Field label="ROHINI ID (9 digits)">
        <input
          type="text"
          value={rohiniId}
          onChange={(e) => setRohiniId(e.target.value)}
          inputMode="numeric"
          pattern="[0-9]{9}"
          maxLength={9}
          className="glass-input glass-input--sm font-mono tabular-nums"
        />
      </Field>
      <Field label="Hospital type">
        <div className="relative">
          <select
            value={hospitalType}
            onChange={(e) => setHospitalType(e.target.value as HospitalType | '')}
            className="glass-input glass-input--sm appearance-none pr-10"
          >
            <option value="">— Select —</option>
            {(Object.keys(HOSPITAL_TYPE_LABELS) as HospitalType[]).map((k) => (
              <option key={k} value={k}>
                {HOSPITAL_TYPE_LABELS[k]}
              </option>
            ))}
          </select>
          <span className="material-symbols-outlined pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[18px] text-on-surface-variant">
            expand_more
          </span>
        </div>
      </Field>
      <Field label="Bed count">
        <input
          type="number"
          min={1}
          value={bedCount}
          onChange={(e) => setBedCount(e.target.value)}
          className="glass-input glass-input--sm font-mono tabular-nums"
        />
      </Field>
      <Field label="HMIS in use">
        <input
          type="text"
          value={hmisVendor}
          onChange={(e) => setHmisVendor(e.target.value)}
          maxLength={128}
          placeholder="Birlamedisoft, Akhil, MediXcel, custom…"
          className="glass-input glass-input--sm"
        />
      </Field>
      <Field label="Expected claims volume">
        <div className="relative">
          <select
            value={claimsBand}
            onChange={(e) =>
              setClaimsBand(e.target.value as ExpectedMonthlyClaimsBand | '')
            }
            className="glass-input glass-input--sm appearance-none pr-10"
          >
            <option value="">— Select —</option>
            {(Object.keys(CLAIMS_BAND_LABELS) as ExpectedMonthlyClaimsBand[]).map(
              (k) => (
                <option key={k} value={k}>
                  {CLAIMS_BAND_LABELS[k]}
                </option>
              ),
            )}
          </select>
          <span className="material-symbols-outlined pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[18px] text-on-surface-variant">
            expand_more
          </span>
        </div>
      </Field>
      <div className="col-span-1 flex justify-end sm:col-span-2">
        <button
          type="submit"
          disabled={saving}
          className="btn-primary"
          style={{ padding: '8px 18px', fontSize: '13px' }}
        >
          <span
            className="material-symbols-outlined text-[18px]"
            style={{ fontVariationSettings: "'FILL' 1" }}
          >
            save
          </span>
          {saving ? 'Saving…' : 'Save profile'}
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="block space-y-1.5">
      <span className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
        {label}
      </span>
      {children}
    </label>
  );
}
