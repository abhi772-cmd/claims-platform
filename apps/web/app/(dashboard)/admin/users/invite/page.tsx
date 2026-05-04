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
    setRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));
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
    <section className="max-w-2xl space-y-6">
      <header className="space-y-1">
        <h2 className="text-2xl font-semibold text-neutral-800">Invite a user</h2>
        <p className="text-sm text-neutral-500">
          The user will receive an email and (if mobile is provided) an SMS to accept.
        </p>
      </header>

      <form onSubmit={onSubmit} className="space-y-4 rounded-md bg-neutral-0 p-6 shadow-sm" noValidate>
        <div className="grid grid-cols-2 gap-4">
          <Field label="First name" id="firstName">
            <input
              id="firstName"
              required
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Last name" id="lastName">
            <input
              id="lastName"
              required
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className={inputClass}
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
            className={inputClass}
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Mobile (optional, +CC...)" id="mobile">
            <input
              id="mobile"
              type="tel"
              value={mobile}
              onChange={(e) => setMobile(e.target.value)}
              className={inputClass}
              placeholder="+919999999999"
            />
          </Field>
          <Field label="Designation (optional)" id="designation">
            <input
              id="designation"
              value={designation}
              onChange={(e) => setDesignation(e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-neutral-700">Roles</legend>
          <div className="grid grid-cols-2 gap-2">
            {ROLE_OPTIONS.map((role) => (
              <label key={role} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={roles.includes(role)}
                  onChange={() => toggleRole(role)}
                />
                {role}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => router.push('/admin/users')}
            className="rounded-sm px-3 py-2 text-sm text-neutral-600 hover:bg-neutral-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-sm bg-primary-600 px-3 py-2 text-sm font-medium text-neutral-0 hover:bg-primary-700 disabled:opacity-60"
          >
            {submitting ? 'Sending invite…' : 'Send invite'}
          </button>
        </div>
      </form>
    </section>
  );
}

const inputClass =
  'w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none';

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
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium text-neutral-700">
        {label}
      </label>
      {children}
    </div>
  );
}
