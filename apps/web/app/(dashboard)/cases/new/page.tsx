'use client';

// Slice CF — intake-flow consent capture.
//
// The form now collects patient PII + a consent block alongside the
// existing case fields. PII + consent are optional today (back-compat
// with Sprint 2-9 callers); the Sprint 10 hard-enforcement rollout
// will require both on tenants whose `requireConsent` flag is on.
//
// Consent defaults are derived from the primary rail:
//   nhcx     → consentType=nhcx_processing
//   pmjay    → consentType=pmjay_processing
//   self_pay → no consent block (no rail-driven processing happens)

import {
  type ConsentType,
  CreateCaseRequestSchema,
  type IntakeConsent,
  type PatientPiiInput,
} from '@claims/contracts';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { CaseApi } from '../../../../lib/api/case.api';

const DEFAULT_NOTICE_TEXT =
  'You authorise the hospital to share your data with NHCX participants and adjudicating ' +
  'payers / TPAs for the purpose of processing this admission and any subsequent claims. ' +
  'Data covered includes identifying details (name, ABHA / Aadhaar / policy number, mobile, email), ' +
  'medical records, and payment information. Retention is governed by IRDAI / DPDP / RBI floors.';

function consentTypeForRail(rail: 'nhcx' | 'pmjay' | 'self_pay'): ConsentType | null {
  if (rail === 'nhcx') return 'nhcx_processing';
  if (rail === 'pmjay') return 'pmjay_processing';
  return null;
}

export default function NewCasePage(): JSX.Element {
  const router = useRouter();
  const { showApiError, showError } = useErrorModal();

  // Case fields
  const [patientName, setPatientName] = useState('');
  const [hospitalMrn, setHospitalMrn] = useState('');
  const [admissionDate, setAdmissionDate] = useState('');
  const [admissionType, setAdmissionType] = useState<'planned' | 'emergency' | 'day_care'>(
    'planned',
  );
  const [primaryRail, setPrimaryRail] = useState<'nhcx' | 'pmjay' | 'self_pay'>('nhcx');

  // PII fields (optional)
  const [aadhaar, setAadhaar] = useState('');
  const [abhaId, setAbhaId] = useState('');
  const [mobile, setMobile] = useState('');

  // Consent capture
  const [captureConsent, setCaptureConsent] = useState(true);
  const [acknowledgedVia, setAcknowledgedVia] = useState('in_person_signature');
  const [noticeText, setNoticeText] = useState(DEFAULT_NOTICE_TEXT);

  const [submitting, setSubmitting] = useState(false);

  const consentType = consentTypeForRail(primaryRail);
  const consentApplicable = consentType !== null;

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();

    const patient: PatientPiiInput | undefined =
      aadhaar.trim() || abhaId.trim() || mobile.trim()
        ? {
            ...(aadhaar.trim() ? { aadhaar: aadhaar.replace(/\s+/g, '') } : {}),
            ...(abhaId.trim() ? { abhaId: abhaId.trim() } : {}),
            ...(mobile.trim() ? { mobile: mobile.replace(/\s+/g, '') } : {}),
          }
        : undefined;

    const consent: IntakeConsent | undefined =
      captureConsent && consentApplicable && patient
        ? {
            consentType,
            // Derive the data categories we collected. The intake
            // form only ever captures aadhaar / abha / mobile right
            // now; future iterations may add policy number, email,
            // medical records.
            dataCategories: Object.keys(patient),
            purposes:
              primaryRail === 'pmjay'
                ? ['eligibility.verify', 'preauth.submit', 'claim.submit']
                : ['eligibility.verify', 'preauth.submit', 'claim.submit', 'communication.send'],
            lawfulBasis: 'consent',
            source: acknowledgedVia,
            evidence: {
              noticeText,
              acknowledgedVia,
              locales: ['en-IN'],
            },
          }
        : undefined;

    const parsed = CreateCaseRequestSchema.safeParse({
      patientName,
      hospitalMrn,
      admissionDate,
      admissionType,
      primaryRail,
      ...(patient ? { patient } : {}),
      ...(consent ? { consent } : {}),
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
          Creates the case + the first claim, captures patient PII (encrypted) and DPDP §6
          consent. Move the claim through eligibility and pre-auth from the case detail page.
        </p>
      </header>
      <form onSubmit={onSubmit} className="space-y-6" noValidate>
        <fieldset className="space-y-4">
          <legend className="text-sm font-semibold text-neutral-800">Case</legend>

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
              onChange={(e) =>
                setPrimaryRail(e.target.value as 'nhcx' | 'pmjay' | 'self_pay')
              }
              className="w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none"
            >
              <option value="nhcx">NHCX (private cashless / reimbursement)</option>
              <option value="pmjay">PMJAY (Ayushman Bharat)</option>
              <option value="self_pay">Self-pay</option>
            </select>
          </div>
        </fieldset>

        <fieldset className="space-y-4 rounded-sm border border-neutral-200 p-4">
          <legend className="px-2 text-sm font-semibold text-neutral-800">
            Patient PII (encrypted at rest)
          </legend>
          <p className="text-xs text-neutral-500">
            Optional; required for eligibility / preauth / claim flows. Stored AES-256-GCM
            encrypted with the per-tenant DEK.
          </p>
          <div className="space-y-1">
            <label htmlFor="aadhaar" className="text-sm font-medium text-neutral-700">
              Aadhaar (12 digits)
            </label>
            <input
              id="aadhaar"
              inputMode="numeric"
              pattern="[0-9 ]*"
              value={aadhaar}
              onChange={(e) => setAadhaar(e.target.value)}
              className="w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 font-mono text-sm focus:border-primary-500 focus:outline-none"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="abha" className="text-sm font-medium text-neutral-700">
              ABHA ID
            </label>
            <input
              id="abha"
              value={abhaId}
              onChange={(e) => setAbhaId(e.target.value)}
              className="w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 font-mono text-sm focus:border-primary-500 focus:outline-none"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="mobile" className="text-sm font-medium text-neutral-700">
              Mobile (E.164, e.g. +91 98765 43210)
            </label>
            <input
              id="mobile"
              type="tel"
              value={mobile}
              onChange={(e) => setMobile(e.target.value)}
              className="w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 font-mono text-sm focus:border-primary-500 focus:outline-none"
            />
          </div>
        </fieldset>

        {consentApplicable && (
          <fieldset className="space-y-4 rounded-sm border border-warning-300 bg-warning-50 p-4">
            <legend className="px-2 text-sm font-semibold text-warning-800">
              DPDP §6 consent capture
            </legend>
            <p className="text-xs text-warning-700">
              Required by Sprint 10 hard-enforcement on tenants with consent rollout enabled.
              Auto-derives the consent type from the primary rail (
              <code className="font-mono">{consentType}</code>).
            </p>
            <label className="flex items-start gap-2 text-sm text-neutral-700">
              <input
                type="checkbox"
                checked={captureConsent}
                onChange={(e) => setCaptureConsent(e.target.checked)}
                className="mt-1"
              />
              <span>
                The data principal has been shown the notice below and has acknowledged.
                Capture this consent now.
              </span>
            </label>
            <div className="space-y-1">
              <label htmlFor="ackvia" className="text-sm font-medium text-neutral-700">
                How was consent acknowledged?
              </label>
              <select
                id="ackvia"
                value={acknowledgedVia}
                onChange={(e) => setAcknowledgedVia(e.target.value)}
                disabled={!captureConsent}
                className="w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none disabled:opacity-60"
              >
                <option value="in_person_signature">In-person, signed paper form</option>
                <option value="abha_otp">ABHA OTP confirmation</option>
                <option value="tele_consent_call">Tele-consent (recorded call)</option>
                <option value="verbal_counter_signed">Verbal, counter-signed by staff</option>
              </select>
            </div>
            <div className="space-y-1">
              <label htmlFor="notice" className="text-sm font-medium text-neutral-700">
                Notice shown to the data principal (verbatim — preserved as evidence)
              </label>
              <textarea
                id="notice"
                rows={5}
                value={noticeText}
                onChange={(e) => setNoticeText(e.target.value)}
                disabled={!captureConsent}
                className="w-full rounded-sm border border-neutral-200 bg-neutral-0 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none disabled:opacity-60"
              />
            </div>
          </fieldset>
        )}

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
