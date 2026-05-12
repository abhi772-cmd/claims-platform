'use client';

import { InviteUserRequestSchema, type InviteUserResponse } from '@claims/contracts';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { useErrorModal } from '../../../../../components/modals/ErrorModal/ErrorModalProvider';
import { apiRequest } from '../../../../../lib/api/client';

const ROLE_OPTIONS = [
  'tenant_admin',
  'billing_manager',
  'insurance_desk_executive',
  'pmam',
  'doctor',
  'finance_viewer',
  'read_only',
] as const;

const LABEL_CLS = 'text-eyebrow uppercase tracking-eyebrow text-on-surface-variant';

export default function InviteUserPage(): JSX.Element {
  const router = useRouter();
  const { showApiError, showError } = useErrorModal();

  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [mobile, setMobile] = useState('');
  const [designation, setDesignation] = useState('');
  const [roles, setRoles] = useState<string[]>(['insurance_desk_executive']);
  const [submitting, setSubmitting] = useState(false);

  function toggleRole(role: string): void {
    setRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role],
    );
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const payload = {
      email,
      firstName,
      lastName,
      mobile: mobile || undefined,
      designation: designation || undefined,
      roles,
    };
    const parsed = InviteUserRequestSchema.safeParse(payload);
    if (!parsed.success) {
      showError('VALIDATION_FAILED', parsed.error.issues[0]?.message);
      return;
    }
    setSubmitting(true);
    try {
      await apiRequest<InviteUserResponse>('/tenant/users', {
        method: 'POST',
        body: parsed.data,
      });
      router.push('/admin/users');
    } catch (err) {
      showApiError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <header className="glass rounded-xl p-6">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">person_add</span>
          <h2 className="text-h2 font-h2 text-on-surface">Invite a user</h2>
        </div>
        <p className="mt-2 text-body text-on-surface-variant">
          The user will receive an email and (if mobile is provided) an SMS to accept.
        </p>
      </header>

      <form onSubmit={onSubmit} className="glass space-y-5 rounded-xl p-6" noValidate>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="First name" id="firstName">
            <input
              id="firstName"
              required
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className="glass-input glass-input--sm"
            />
          </Field>
          <Field label="Last name" id="lastName">
            <input
              id="lastName"
              required
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className="glass-input glass-input--sm"
            />
          </Field>
        </div>
        <Field label="Email" id="email">
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="glass-input glass-input--sm"
            placeholder="dr.smith@hospital.com"
          />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Mobile (optional, +CC...)" id="mobile">
            <input
              id="mobile"
              type="tel"
              value={mobile}
              onChange={(e) => setMobile(e.target.value)}
              className="glass-input glass-input--sm font-mono"
              placeholder="+919999999999"
            />
          </Field>
          <Field label="Designation (optional)" id="designation">
            <input
              id="designation"
              value={designation}
              onChange={(e) => setDesignation(e.target.value)}
              className="glass-input glass-input--sm"
            />
          </Field>
        </div>

        <fieldset className="space-y-2">
          <legend className={LABEL_CLS}>Roles</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {ROLE_OPTIONS.map((role) => {
              const checked = roles.includes(role);
              return (
                <label
                  key={role}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-body-sm transition-all ${
                    checked
                      ? 'border-primary-container/40 bg-primary/5 text-on-primary-fixed-variant'
                      : 'border-white/60 bg-surface-container-lowest/50 text-on-surface hover:bg-surface-container-lowest'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleRole(role)}
                    className="h-4 w-4 accent-primary"
                  />
                  <span className="font-mono">{role}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={() => router.push('/admin/users')}
            className="btn-outline"
            style={{ padding: '10px 22px', fontSize: '13px' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="btn-cta group"
            style={{ padding: '10px 22px', fontSize: '13px' }}
          >
            {submitting ? 'Sending invite…' : 'Send invite'}
            <span
              className="material-symbols-outlined ml-1 text-[18px] transition-transform group-hover:translate-x-1"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              send
            </span>
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className={LABEL_CLS}>
        {label}
      </label>
      {children}
    </div>
  );
}
