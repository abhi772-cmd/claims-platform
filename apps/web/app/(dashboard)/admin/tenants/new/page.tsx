'use client';

import { type CreateTenantResponse } from '@claims/contracts';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';

import { useErrorModal } from '../../../../../components/modals/ErrorModal/ErrorModalProvider';
import { TenantAdminApi } from '../../../../../lib/api/tenant-admin.api';

// Slug auto-derivation: take displayName, lowercase, replace anything
// non-alphanumeric with a single dash, trim leading/trailing dashes.
// Ops can override the suggestion before submit.
function deriveSlug(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export default function NewTenantPage(): JSX.Element {
  const { showApiError } = useErrorModal();
  const [displayName, setDisplayName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [adminFirstName, setAdminFirstName] = useState('');
  const [adminLastName, setAdminLastName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminMobile, setAdminMobile] = useState('');
  const [adminDesignation, setAdminDesignation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CreateTenantResponse | null>(null);

  function onDisplayNameChange(v: string): void {
    setDisplayName(v);
    if (!slugTouched) setSlug(deriveSlug(v));
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    try {
      const out = await TenantAdminApi.create({
        slug: slug.trim(),
        displayName: displayName.trim(),
        primaryAdmin: {
          email: adminEmail.trim(),
          firstName: adminFirstName.trim(),
          lastName: adminLastName.trim(),
          ...(adminMobile.trim() ? { mobile: adminMobile.trim() } : {}),
          ...(adminDesignation.trim() ? { designation: adminDesignation.trim() } : {}),
        },
      });
      setResult(out);
    } catch (err) {
      showApiError(err);
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <div className="mx-auto flex w-full max-w-[700px] flex-col gap-6">
        <section className="glass rounded-xl border border-green-200 bg-green-50/40 p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-500/20 text-green-700">
              <span
                className="material-symbols-outlined"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                check_circle
              </span>
            </div>
            <h2 className="text-h2 font-h2 text-on-surface">Hospital created</h2>
          </div>
          <dl className="mt-5 grid grid-cols-1 gap-3 text-body-sm sm:grid-cols-2">
            <Pair k="Display name" v={result.tenant.displayName} />
            <Pair k="Slug" v={result.tenant.slug} mono />
            <Pair k="Tenant ID" v={result.tenant.id} mono />
            <Pair k="Lifecycle state" v={result.tenant.lifecycleState} />
            <Pair k="Primary admin email" v={result.primaryAdmin.email} mono />
            <Pair
              k="Invite expires"
              v={new Date(result.primaryAdmin.inviteExpiresAt).toLocaleString()}
            />
          </dl>
          <p className="mt-5 text-body-sm text-on-surface-variant">
            An invite email + SMS have been sent to {result.primaryAdmin.email}. The
            primary admin sets a password, enrolls MFA, and lands on the onboarding
            wizard for their tenant. You can monitor progress from the hospital list.
          </p>
          <div className="mt-5 flex gap-3">
            <Link
              href="/admin/tenants"
              className="btn-primary inline-flex items-center"
              style={{ padding: '8px 18px', fontSize: '13px' }}
            >
              <span className="material-symbols-outlined text-[18px]">list</span>
              Back to hospitals
            </Link>
            <button
              type="button"
              onClick={() => {
                setResult(null);
                setDisplayName('');
                setSlug('');
                setSlugTouched(false);
                setAdminFirstName('');
                setAdminLastName('');
                setAdminEmail('');
                setAdminMobile('');
                setAdminDesignation('');
              }}
              className="btn-outline inline-flex items-center"
              style={{ padding: '8px 18px', fontSize: '13px' }}
            >
              <span className="material-symbols-outlined text-[18px]">add</span>
              Create another
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[700px] flex-col gap-6">
      <header className="glass rounded-xl p-6">
        <Link
          href="/admin/tenants"
          className="text-body-sm font-medium text-primary hover:underline"
        >
          ← Back to hospitals
        </Link>
        <h2 className="mt-2 text-h2 font-h2 text-on-surface">New hospital</h2>
        <p className="mt-1 text-body text-on-surface-variant">
          Creates the tenant record, seeds its role catalog (tenant_admin, billing_manager,
          insurance_desk_executive, pmam, doctor, finance_viewer, read_only), and sends an
          invite email + SMS to the primary admin.
        </p>
      </header>

      <form onSubmit={onSubmit} className="glass space-y-5 rounded-xl p-6">
        <fieldset className="space-y-4">
          <legend className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
            Hospital identity
          </legend>
          <Field label="Display name">
            <input
              type="text"
              required
              maxLength={256}
              value={displayName}
              onChange={(e) => onDisplayNameChange(e.target.value)}
              placeholder="Apollo Hospitals Indore"
              className="glass-input glass-input--sm"
            />
          </Field>
          <Field label="Slug (URL-safe)">
            <input
              type="text"
              required
              minLength={3}
              maxLength={48}
              pattern="^[a-z][a-z0-9-]*[a-z0-9]$"
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugTouched(true);
              }}
              placeholder="apollo-indore"
              className="glass-input glass-input--sm font-mono"
            />
            <p className="text-body-sm text-on-surface-variant">
              3–48 chars. Lowercase letters, digits, dashes. Auto-suggested from
              display name; edit to override.
            </p>
          </Field>
        </fieldset>

        <fieldset className="space-y-4 border-t border-outline-variant/30 pt-5">
          <legend className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
            Primary admin
          </legend>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="First name">
              <input
                type="text"
                required
                value={adminFirstName}
                onChange={(e) => setAdminFirstName(e.target.value)}
                maxLength={128}
                className="glass-input glass-input--sm"
              />
            </Field>
            <Field label="Last name">
              <input
                type="text"
                required
                value={adminLastName}
                onChange={(e) => setAdminLastName(e.target.value)}
                maxLength={128}
                className="glass-input glass-input--sm"
              />
            </Field>
          </div>
          <Field label="Email">
            <input
              type="email"
              required
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
              maxLength={254}
              placeholder="admin@hospital.in"
              className="glass-input glass-input--sm"
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Mobile (optional)">
              <input
                type="tel"
                value={adminMobile}
                onChange={(e) => setAdminMobile(e.target.value)}
                minLength={7}
                maxLength={20}
                placeholder="+91 98XXXXXXXX"
                className="glass-input glass-input--sm font-mono"
              />
            </Field>
            <Field label="Designation (optional)">
              <input
                type="text"
                value={adminDesignation}
                onChange={(e) => setAdminDesignation(e.target.value)}
                maxLength={128}
                placeholder="Chief Medical Officer"
                className="glass-input glass-input--sm"
              />
            </Field>
          </div>
        </fieldset>

        <div className="flex justify-end gap-3 border-t border-outline-variant/30 pt-5">
          <Link
            href="/admin/tenants"
            className="btn-outline inline-flex items-center"
            style={{ padding: '8px 18px', fontSize: '13px' }}
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={submitting}
            className="btn-primary inline-flex items-center"
            style={{ padding: '8px 18px', fontSize: '13px' }}
          >
            <span
              className="material-symbols-outlined text-[18px]"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              send
            </span>
            {submitting ? 'Provisioning…' : 'Create hospital + send invite'}
          </button>
        </div>
      </form>
    </div>
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

function Pair({
  k,
  v,
  mono,
}: {
  k: string;
  v: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <div>
      <dt className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
        {k}
      </dt>
      <dd className={`text-on-surface ${mono ? 'font-mono break-all' : ''}`}>{v}</dd>
    </div>
  );
}
