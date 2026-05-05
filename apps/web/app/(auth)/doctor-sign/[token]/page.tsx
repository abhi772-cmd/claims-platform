'use client';

import {
  type DoctorTokenPreview,
  SignWithDoctorTokenRequestSchema,
} from '@claims/contracts';
import { useEffect, useState, type FormEvent } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { DoctorApi } from '../../../../lib/api/doctor.api';

interface PageProps {
  params: { token: string };
}

export default function DoctorSignPage({ params }: PageProps): JSX.Element {
  const { showApiError, showError } = useErrorModal();
  const [preview, setPreview] = useState<DoctorTokenPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [hprId, setHprId] = useState('');
  const [hprOtp, setHprOtp] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [signed, setSigned] = useState<{ doctorFullName: string; signedAt: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    DoctorApi.preview(params.token)
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch((err: unknown) => {
        if (!cancelled) showApiError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [params.token, showApiError]);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const parsed = SignWithDoctorTokenRequestSchema.safeParse({
      hprId,
      hprOtp,
      ...(note ? { signatureNote: note } : {}),
    });
    if (!parsed.success) {
      showError('VALIDATION_FAILED', parsed.error.issues[0]?.message);
      return;
    }
    setSubmitting(true);
    try {
      const out = await DoctorApi.sign(params.token, parsed.data);
      setSigned({ doctorFullName: out.doctorFullName, signedAt: out.signedAt });
    } catch (err) {
      showApiError(err);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <p className="text-sm text-neutral-500">Loading…</p>;
  if (!preview) {
    return (
      <div className="space-y-2 rounded-md bg-neutral-0 p-8 shadow-md">
        <h1 className="text-lg font-semibold text-neutral-800">This link is no longer valid</h1>
        <p className="text-sm text-neutral-500">
          Doctor signature links expire 10 minutes after they&apos;re sent. Ask the insurance desk
          to send a new one.
        </p>
      </div>
    );
  }
  if (signed) {
    return (
      <div className="space-y-3 rounded-md bg-neutral-0 p-8 shadow-md">
        <h1 className="text-xl font-semibold text-success-700">Signature recorded</h1>
        <p className="text-sm text-neutral-700">
          Thank you, {signed.doctorFullName}. The pre-auth bundle for{' '}
          <span className="font-medium">{preview.patientName}</span> has been signed at{' '}
          {new Date(signed.signedAt).toLocaleString()}.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 rounded-md bg-neutral-0 p-8 shadow-md">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-800">Sign clinical justification</h1>
        <p className="text-sm text-neutral-500">
          Dr. {preview.doctorFirstName} {preview.doctorLastName} —{' '}
          {preview.tenantDisplayName}
        </p>
      </header>
      <dl className="space-y-1 rounded-sm border border-neutral-200 bg-neutral-50 p-3 text-sm">
        <div className="flex justify-between">
          <dt className="text-neutral-500">Patient</dt>
          <dd className="font-medium text-neutral-800">{preview.patientName}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-neutral-500">Case</dt>
          <dd className="font-medium text-neutral-800">{preview.caseRef}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-neutral-500">Requested by</dt>
          <dd className="font-medium text-neutral-800">{preview.requesterName}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-neutral-500">Expires</dt>
          <dd className="text-neutral-700">{new Date(preview.expiresAt).toLocaleTimeString()}</dd>
        </div>
      </dl>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="space-y-1">
          <label htmlFor="hpr" className="text-sm font-medium text-neutral-700">
            HPR ID (14 digits)
          </label>
          <input
            id="hpr"
            type="text"
            inputMode="numeric"
            pattern="[0-9]{14}"
            required
            value={hprId}
            onChange={(e) => setHprId(e.target.value)}
            className="w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 font-mono text-sm focus:border-primary-500 focus:outline-none"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="otp" className="text-sm font-medium text-neutral-700">
            HPR OTP (6 digits)
          </label>
          <input
            id="otp"
            type="text"
            inputMode="numeric"
            pattern="[0-9]{6}"
            autoComplete="one-time-code"
            required
            value={hprOtp}
            onChange={(e) => setHprOtp(e.target.value)}
            className="w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 font-mono tracking-wider focus:border-primary-500 focus:outline-none"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="note" className="text-sm font-medium text-neutral-700">
            Clinical note (optional)
          </label>
          <textarea
            id="note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={2000}
            className="w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-sm bg-primary-600 px-3 py-2 text-sm font-medium text-neutral-0 hover:bg-primary-700 disabled:opacity-60"
        >
          {submitting ? 'Signing…' : 'Sign with HPR'}
        </button>
      </form>
    </div>
  );
}
