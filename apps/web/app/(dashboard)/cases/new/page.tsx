'use client';

import { CreateCaseRequestSchema } from '@claims/contracts';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { CaseApi } from '../../../../lib/api/case.api';

export default function NewCasePage(): JSX.Element {
  const router = useRouter();
  const { showApiError, showError } = useErrorModal();
  const [patientName, setPatientName] = useState('');
  const [hospitalMrn, setHospitalMrn] = useState('');
  const [admissionDate, setAdmissionDate] = useState('');
  const [admissionType, setAdmissionType] = useState<'planned' | 'emergency' | 'day_care'>(
    'planned',
  );
  const [primaryRail, setPrimaryRail] = useState<'nhcx' | 'pmjay' | 'self_pay'>('nhcx');
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const parsed = CreateCaseRequestSchema.safeParse({
      patientName,
      hospitalMrn,
      admissionDate,
      admissionType,
      primaryRail,
    });
    if (!parsed.success) {
      showError('VALIDATION_FAILED', parsed.error.issues[0]?.message);
      return;
    }
    setSubmitting(true);
    try {
      const out = await CaseApi.create(parsed.data);
      router.push(`/cases/${out.id}`);
    } catch (err) {
      showApiError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6 rounded-md bg-neutral-0 p-8 shadow-md">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-800">New case</h1>
        <p className="text-sm text-neutral-500">
          Creates the case + the first claim. Move the claim through eligibility and pre-auth from
          the case detail page.
        </p>
      </header>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="space-y-1">
          <label htmlFor="patient" className="text-sm font-medium text-neutral-700">
            Patient name
          </label>
          <input
            id="patient"
            required
            value={patientName}
            onChange={(e) => setPatientName(e.target.value)}
            className="w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="mrn" className="text-sm font-medium text-neutral-700">
            Hospital MRN
          </label>
          <input
            id="mrn"
            required
            value={hospitalMrn}
            onChange={(e) => setHospitalMrn(e.target.value)}
            className="w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 font-mono text-sm focus:border-primary-500 focus:outline-none"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="adm-date" className="text-sm font-medium text-neutral-700">
            Admission date
          </label>
          <input
            id="adm-date"
            type="date"
            required
            value={admissionDate}
            onChange={(e) => setAdmissionDate(e.target.value)}
            className="w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="adm-type" className="text-sm font-medium text-neutral-700">
            Admission type
          </label>
          <select
            id="adm-type"
            value={admissionType}
            onChange={(e) =>
              setAdmissionType(e.target.value as 'planned' | 'emergency' | 'day_care')
            }
            className="w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none"
          >
            <option value="planned">Planned</option>
            <option value="emergency">Emergency</option>
            <option value="day_care">Day care</option>
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor="rail" className="text-sm font-medium text-neutral-700">
            Primary rail
          </label>
          <select
            id="rail"
            value={primaryRail}
            onChange={(e) => setPrimaryRail(e.target.value as 'nhcx' | 'pmjay' | 'self_pay')}
            className="w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none"
          >
            <option value="nhcx">NHCX (private cashless / reimbursement)</option>
            <option value="pmjay">PMJAY (Ayushman Bharat)</option>
            <option value="self_pay">Self-pay</option>
          </select>
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-sm bg-primary-600 px-3 py-2 text-sm font-medium text-neutral-0 hover:bg-primary-700 disabled:opacity-60"
        >
          {submitting ? 'Creating…' : 'Create case'}
        </button>
      </form>
    </div>
  );
}
