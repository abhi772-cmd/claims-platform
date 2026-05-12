'use client';

// Slice CF — intake-flow consent capture (Stitch-canonical layout).
//
// Three glass cards: Case Details · Identity & PII · DPDP Consent Capture.
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

const INPUT_CLS =
  'w-full rounded-lg border border-white bg-surface-container-lowest/50 px-4 py-3 text-body text-on-surface placeholder:text-outline-variant shadow-sm outline-none transition-all focus:border-primary-container focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary-container';

const LABEL_CLS =
  'text-eyebrow uppercase tracking-eyebrow text-on-surface-variant';

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
    <div className="mx-auto w-full max-w-[720px]">
      {/* Page Header */}
      <div className="mb-6">
        <h2 className="text-h2 font-h2 text-primary">New Case Intake</h2>
        <p className="mt-1 text-body text-on-surface-variant">
          Initiate a new claim by capturing patient and clinical details.
        </p>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
        {/* Card 1: Case Details */}
        <fieldset className="glass rounded-xl p-6">
          <div className="mb-6 flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">assignment</span>
            <h3 className="text-h3 font-h3 text-on-surface">Case Details</h3>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="col-span-1 flex flex-col gap-1 md:col-span-2">
              <label htmlFor="patient" className={LABEL_CLS}>
                Patient name
              </label>
              <input
                id="patient"
                required
                value={patientName}
                onChange={(e) => setPatientName(e.target.value)}
                placeholder="Full legal name"
                className={INPUT_CLS}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="mrn" className={LABEL_CLS}>
                Medical Record Number (MRN)
              </label>
              <input
                id="mrn"
                required
                value={hospitalMrn}
                onChange={(e) => setHospitalMrn(e.target.value)}
                placeholder="MRN-XXXX-XXXX"
                className={`${INPUT_CLS} font-mono`}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="adm-date" className={LABEL_CLS}>
                Admission date
              </label>
              <input
                id="adm-date"
                type="date"
                required
                value={admissionDate}
                onChange={(e) => setAdmissionDate(e.target.value)}
                className={INPUT_CLS}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="adm-type" className={LABEL_CLS}>
                Admission type
              </label>
              <div className="relative">
                <select
                  id="adm-type"
                  value={admissionType}
                  onChange={(e) =>
                    setAdmissionType(e.target.value as 'planned' | 'emergency' | 'day_care')
                  }
                  className={`${INPUT_CLS} appearance-none pr-10`}
                >
                  <option value="planned">Planned</option>
                  <option value="emergency">Emergency</option>
                  <option value="day_care">Day care</option>
                </select>
                <span className="material-symbols-outlined pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant">
                  expand_more
                </span>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="rail" className={LABEL_CLS}>
                Primary rail
              </label>
              <div className="relative">
                <select
                  id="rail"
                  value={primaryRail}
                  onChange={(e) =>
                    setPrimaryRail(e.target.value as 'nhcx' | 'pmjay' | 'self_pay')
                  }
                  className={`${INPUT_CLS} appearance-none pr-10`}
                >
                  <option value="nhcx">NHCX (private cashless / reimbursement)</option>
                  <option value="pmjay">PMJAY (Ayushman Bharat)</option>
                  <option value="self_pay">Self-pay</option>
                </select>
                <span className="material-symbols-outlined pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant">
                  expand_more
                </span>
              </div>
            </div>
          </div>
        </fieldset>

        {/* Card 2: Identity & PII */}
        <fieldset className="glass rounded-xl p-6">
          <div className="mb-6 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary">badge</span>
              <h3 className="text-h3 font-h3 text-on-surface">Identity &amp; PII</h3>
            </div>
            <span className="rounded bg-primary-fixed-dim/20 px-2 py-1 text-eyebrow uppercase tracking-eyebrow text-primary">
              Secure
            </span>
          </div>
          <p className="mb-4 text-body-sm text-on-surface-variant">
            Optional; required for eligibility / preauth / claim flows. Stored AES-256-GCM
            encrypted with the per-tenant DEK.
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="aadhaar" className={LABEL_CLS}>
                Aadhaar Number
              </label>
              <input
                id="aadhaar"
                inputMode="numeric"
                maxLength={14}
                value={aadhaar}
                onChange={(e) => setAadhaar(e.target.value)}
                placeholder="XXXX XXXX XXXX"
                className={`${INPUT_CLS} font-mono tracking-widest`}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="abha" className={LABEL_CLS}>
                ABHA ID
              </label>
              <input
                id="abha"
                value={abhaId}
                onChange={(e) => setAbhaId(e.target.value)}
                placeholder="XX-XXXX-XXXX-XXXX"
                className={`${INPUT_CLS} font-mono tracking-widest`}
              />
            </div>
            <div className="flex flex-col gap-1 md:col-span-2">
              <label htmlFor="mobile" className={LABEL_CLS}>
                Mobile Number
              </label>
              <div className="flex">
                <span className="flex items-center rounded-l-lg border border-r-0 border-white bg-surface-container-high px-4 py-3 text-body text-on-surface-variant">
                  +91
                </span>
                <input
                  id="mobile"
                  type="tel"
                  maxLength={11}
                  value={mobile}
                  onChange={(e) => setMobile(e.target.value)}
                  placeholder="XXXXX XXXXX"
                  className={`${INPUT_CLS} rounded-l-none font-mono`}
                />
              </div>
            </div>
          </div>
        </fieldset>

        {/* Card 3: DPDP Consent */}
        {consentApplicable && (
          <fieldset
            className="rounded-xl border border-secondary-container/30 p-6 shadow-md backdrop-blur-[14px]"
            style={{
              background:
                'linear-gradient(135deg, rgba(254, 170, 30, 0.10) 0%, rgba(254, 170, 30, 0.04) 100%)',
            }}
          >
            <div className="mb-4 flex items-start gap-3">
              <span className="material-symbols-outlined mt-1 text-secondary-container">
                shield_lock
              </span>
              <div>
                <h3 className="text-h3 font-h3 text-on-surface">
                  DPDP Act 2023 Consent Capture
                </h3>
                <p className="mt-1 text-body-sm text-on-surface-variant">
                  Mandatory Section 6 compliance — auto-derives consent type from the primary
                  rail (
                  <code className="rounded bg-white/70 px-1 py-0.5 font-mono text-body-sm">
                    {consentType}
                  </code>
                  ).
                </p>
              </div>
            </div>

            <div className="mb-4 max-h-40 overflow-y-auto rounded-lg border border-white/40 bg-white/50 p-4 text-body-sm leading-relaxed text-on-surface-variant">
              <p className="mb-2 font-bold">Verbatim notice (read to the data principal):</p>
              <textarea
                rows={5}
                value={noticeText}
                onChange={(e) => setNoticeText(e.target.value)}
                disabled={!captureConsent}
                className="w-full bg-transparent text-body-sm text-on-surface-variant outline-none disabled:opacity-60"
              />
            </div>

            <div className="flex flex-col gap-4">
              <label className="group flex cursor-pointer items-start gap-3">
                <div className="relative mt-1 flex items-center justify-center">
                  <input
                    type="checkbox"
                    checked={captureConsent}
                    onChange={(e) => setCaptureConsent(e.target.checked)}
                    className="peer h-5 w-5 appearance-none rounded border-2 border-secondary-container bg-white/50 transition-colors checked:border-secondary-container checked:bg-secondary-container"
                  />
                  <span className="material-symbols-outlined pointer-events-none absolute text-[16px] text-white opacity-0 peer-checked:opacity-100">
                    check
                  </span>
                </div>
                <span className="text-body text-on-surface transition-colors group-hover:text-primary">
                  I confirm the data principal has explicitly agreed to processing of their
                  personal data for claims facilitation.
                </span>
              </label>

              <div className="flex w-full flex-col gap-1 md:w-1/2">
                <label htmlFor="ackvia" className={LABEL_CLS}>
                  Acknowledgement method
                </label>
                <div className="relative">
                  <select
                    id="ackvia"
                    value={acknowledgedVia}
                    onChange={(e) => setAcknowledgedVia(e.target.value)}
                    disabled={!captureConsent}
                    className={`${INPUT_CLS} appearance-none border-secondary-container/30 pr-10 focus:border-secondary-container disabled:opacity-60`}
                  >
                    <option value="in_person_signature">In-person, signed paper form</option>
                    <option value="abha_otp">ABHA OTP confirmation</option>
                    <option value="tele_consent_call">Tele-consent (recorded call)</option>
                    <option value="verbal_counter_signed">Verbal, counter-signed by staff</option>
                  </select>
                  <span className="material-symbols-outlined pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant">
                    expand_more
                  </span>
                </div>
              </div>
            </div>
          </fieldset>
        )}

        {/* Submit */}
        <div className="mt-2 flex justify-end">
          <button
            type="submit"
            disabled={submitting}
            className="btn-cta group"
            style={{ padding: '14px 32px', fontSize: '14px' }}
          >
            {submitting ? 'Creating…' : 'Create case'}
            <span
              className="material-symbols-outlined ml-2 text-[20px] transition-transform group-hover:translate-x-1"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              arrow_forward
            </span>
          </button>
        </div>
      </form>
    </div>
  );
}
