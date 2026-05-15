'use client';

import {
  type DoctorTokenPreview,
  SignWithDoctorTokenRequestSchema,
} from '@claims/contracts';
import { useEffect, useState, type FormEvent } from 'react';

import { AuthCard } from '../../../../components/auth/AuthCard';
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

  if (loading) {
    return (
      <AuthCard eyebrow="Clinician signature" title="Loading…">
        <p className="mt-3 text-sm text-neutral-500">One moment.</p>
      </AuthCard>
    );
  }
  if (!preview) {
    return (
      <AuthCard tone="warning" eyebrow="Clinician signature" title="This link is no longer valid">
        <p className="mt-3 text-sm text-neutral-700">
          Doctor signature links expire 10 minutes after they&apos;re sent. Ask the insurance desk
          to send a new one.
        </p>
      </AuthCard>
    );
  }
  if (signed) {
    return (
      <AuthCard tone="success" eyebrow="Clinician signature" title="Signature recorded">
        <p className="mt-3 text-sm text-neutral-700">
          Thank you, {signed.doctorFullName}. The pre-auth bundle for{' '}
          <span className="font-medium text-neutral-900">{preview.patientName}</span> was signed at{' '}
          {new Date(signed.signedAt).toLocaleString()}.
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      eyebrow="Clinician signature"
      title="Sign clinical justification"
      subtitle={`Dr. ${preview.doctorFirstName} ${preview.doctorLastName} — ${preview.tenantDisplayName}`}
    >
      <dl className="mt-4 space-y-1.5 rounded-md border border-neutral-100 bg-white/50 p-3 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-neutral-500">Patient</dt>
          <dd className="font-medium text-neutral-800">{preview.patientName}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-neutral-500">Case</dt>
          <dd className="font-medium text-neutral-800">{preview.caseRef}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-neutral-500">Requested by</dt>
          <dd className="font-medium text-neutral-800">{preview.requesterName}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-neutral-500">Expires</dt>
          <dd className="text-neutral-700">{new Date(preview.expiresAt).toLocaleTimeString()}</dd>
        </div>
      </dl>
      <form onSubmit={onSubmit} className="mt-5 space-y-4" noValidate>
        <div className="space-y-1.5">
          <label
            htmlFor="hpr"
            className="text-xs font-semibold uppercase tracking-wider text-neutral-600"
          >
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
            className="w-full rounded-md border border-neutral-200 bg-white/80 px-3.5 py-2.5 font-mono text-sm transition focus:border-primary-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-500/20"
          />
        </div>
        <div className="space-y-1.5">
          <label
            htmlFor="otp"
            className="text-xs font-semibold uppercase tracking-wider text-neutral-600"
          >
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
            className="w-full rounded-md border border-neutral-200 bg-white/80 px-3.5 py-2.5 font-mono text-sm tracking-wider transition focus:border-primary-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-500/20"
          />
        </div>
        <div className="space-y-1.5">
          <label
            htmlFor="note"
            className="text-xs font-semibold uppercase tracking-wider text-neutral-600"
          >
            Clinical note (optional)
          </label>
          <textarea
            id="note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={2000}
            className="w-full rounded-md border border-neutral-200 bg-white/80 px-3.5 py-2.5 text-sm transition focus:border-primary-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-500/20"
          />
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="btn-cta mt-2 w-full"
          style={{ padding: '12px 16px', fontSize: '14px' }}
        >
          {submitting ? 'Signing…' : 'Sign with HPR'}
        </button>
      </form>
    </AuthCard>
  );
}
