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
  type Payer,
  type PatientPiiInput,
  type PmjayPolicy,
  type VerifyCoverageByIdentifiersResponse,
} from '@claims/contracts';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { CoverageDetailsCard } from '../../../../components/identity/CoverageDetailsCard';
import { IdentityDiscovery, type DiscoveredIdentity } from '../../../../components/identity/IdentityDiscovery';
import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { PolicySelector } from '../../../../components/pmjay/PolicySelector';
import { CaseApi } from '../../../../lib/api/case.api';
import { MasterDataApi } from '../../../../lib/api/master-data.api';

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

  // Preflight eligibility — payer + policy identifier captured up
  // front so we can verify coverage BEFORE the case is created and
  // auto-fill the policy room-rent limit + sum insured / deductible
  // hints below.
  const [payerCode, setPayerCode] = useState('');
  const [policyNumber, setPolicyNumber] = useState('');
  const [payers, setPayers] = useState<Payer[]>([]);
  // Coverage details — populated when the Find patient widget runs a
  // successful verify-by-identifiers. The CoverageDetailsCard below
  // self-hides until this is non-null.
  const [verifyResult, setVerifyResult] = useState<VerifyCoverageByIdentifiersResponse | null>(
    null,
  );
  // True after the operator types into policyRoomRentLimitRupees by
  // hand — prevents the preflight result from clobbering an explicit
  // override.
  const [roomLimitEdited, setRoomLimitEdited] = useState(false);

  // PMJAY-only — once the operator picks a policy from the policies
  // lookup it auto-fills payerCode, policyNumber, and (if the lookup
  // identifier was ABHA) abhaId so the rest of the form is pre-seeded.
  const [pmjayPolicy, setPmjayPolicy] = useState<PmjayPolicy | null>(null);

  // T2-14 — room rent pre-warn (all optional). Operator enters
  // rupees in the UI; we convert to paise at submit time to match
  // the Int-paise wire format.
  const [roomDailyRateRupees, setRoomDailyRateRupees] = useState('');
  const [policyRoomRentLimitRupees, setPolicyRoomRentLimitRupees] = useState('');
  const [estimatedStayDays, setEstimatedStayDays] = useState('');

  // Consent capture
  const [captureConsent, setCaptureConsent] = useState(true);
  const [acknowledgedVia, setAcknowledgedVia] = useState('in_person_signature');
  const [noticeText, setNoticeText] = useState(DEFAULT_NOTICE_TEXT);

  const [submitting, setSubmitting] = useState(false);

  const consentType = consentTypeForRail(primaryRail);
  const consentApplicable = consentType !== null;

  // Load the payer list once. Filter to the current rail so the
  // dropdown only shows payers the tenant can actually transact
  // with. Self-pay shows zero entries (operator skips preflight).
  useEffect(() => {
    let cancelled = false;
    if (primaryRail === 'self_pay') {
      setPayers([]);
      setPayerCode('');
      return () => {
        cancelled = true;
      };
    }
    MasterDataApi.listPayers({ rail: primaryRail })
      .then((res) => {
        if (cancelled) return;
        setPayers(res.payers);
      })
      .catch((err: unknown) => {
        if (!cancelled) showApiError(err);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryRail]);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();

    const patient: PatientPiiInput | undefined =
      aadhaar.trim() || abhaId.trim() || mobile.trim() || policyNumber.trim()
        ? {
            ...(aadhaar.trim() ? { aadhaar: aadhaar.replace(/\s+/g, '') } : {}),
            ...(abhaId.trim() ? { abhaId: abhaId.trim() } : {}),
            ...(mobile.trim() ? { mobile: mobile.replace(/\s+/g, '') } : {}),
            ...(policyNumber.trim() ? { policyNumber: policyNumber.trim() } : {}),
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

    // T2-14 — convert rupee inputs to paise; leave fields out
    // entirely (vs. sending 0) when the operator didn't type a number
    // so the server stores NULL and the case-detail banner skips.
    const rateRupees = roomDailyRateRupees.trim();
    const limitRupees = policyRoomRentLimitRupees.trim();
    const stayDays = estimatedStayDays.trim();
    const roomDailyRate = rateRupees ? Math.round(Number(rateRupees) * 100) : undefined;
    const policyRoomRentLimit = limitRupees ? Math.round(Number(limitRupees) * 100) : undefined;
    const estimatedStayDaysNum = stayDays ? Number(stayDays) : undefined;

    const parsed = CreateCaseRequestSchema.safeParse({
      patientName,
      hospitalMrn,
      admissionDate,
      admissionType,
      primaryRail,
      ...(patient ? { patient } : {}),
      ...(consent ? { consent } : {}),
      ...(roomDailyRate !== undefined ? { roomDailyRate } : {}),
      ...(policyRoomRentLimit !== undefined ? { policyRoomRentLimit } : {}),
      ...(estimatedStayDaysNum !== undefined ? { estimatedStayDays: estimatedStayDaysNum } : {}),
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
        <h2 className="text-h2 font-h2 text-primary">New case intake</h2>
        <p className="mt-1 text-body text-on-surface-variant">
          Initiate a new claim by capturing patient and clinical details.
        </p>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
        {/* Phase 1 — Unified identity discovery widget. Operator picks
            an identifier type (mobile/ABHA/Aadhaar/policy), the widget
            routes to the right backend based on rail, and the result
            auto-fills the form fields below. PolicySelector is kept
            below as the explicit PMJAY policy picker for operators who
            already know the policy number. */}
        {primaryRail !== 'self_pay' ? (
          <IdentityDiscovery
            rail={primaryRail}
            payers={payers}
            payerCode={payerCode || null}
            onPayerChange={setPayerCode}
            patientName={patientName}
            hospitalMrn={hospitalMrn}
            serviceDate={admissionDate || null}
            onIdentityDiscovered={(identity: DiscoveredIdentity) => {
              if (identity.payerCode) setPayerCode(identity.payerCode);
              if (identity.policyNumber) setPolicyNumber(identity.policyNumber);
              if (identity.identifierKind === 'abha') setAbhaId(identity.identifierValue);
              if (identity.identifierKind === 'aadhaar') setAadhaar(identity.identifierValue);
              if (identity.verifyResult) {
                setVerifyResult(identity.verifyResult);
                if (identity.verifyResult.roomRentLimitRupees !== null && !roomLimitEdited) {
                  setPolicyRoomRentLimitRupees(String(identity.verifyResult.roomRentLimitRupees));
                }
              }
            }}
          />
        ) : null}

        {/* Coverage details — self-hides until a successful
            verify-by-identifiers result lands. Replaces the legacy
            Verify coverage card's result tiles, which were tightly
            coupled to that card's own button. */}
        <CoverageDetailsCard result={verifyResult} />


        {/* PMJAY-only Card 00 — kept for backward compatibility. The
            IdentityDiscovery widget above now handles the PMJAY policy
            picker flow, but this card stays so operators who already
            have a policy number can drop straight into it. */}
        {primaryRail === 'pmjay' ? (
          <PolicySelector
            pickedPolicy={pmjayPolicy}
            onPolicyPicked={(policy) => {
              setPmjayPolicy(policy);
              setPayerCode(policy.payerId);
              setPolicyNumber(policy.policyNumber);
            }}
            onCleared={() => {
              setPmjayPolicy(null);
              setPayerCode('');
              setPolicyNumber('');
            }}
          />
        ) : null}

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

        {/* T2-14 — Room & coverage pre-warn. All three inputs
            optional; the live card materialises only when both
            room rate AND policy limit are typed. */}
        <RoomCoverageCard
          roomDailyRateRupees={roomDailyRateRupees}
          setRoomDailyRateRupees={setRoomDailyRateRupees}
          policyRoomRentLimitRupees={policyRoomRentLimitRupees}
          setPolicyRoomRentLimitRupees={(v) => {
            setPolicyRoomRentLimitRupees(v);
            // Operator typed a value → don't let a subsequent preflight
            // result clobber their override.
            setRoomLimitEdited(true);
          }}
          estimatedStayDays={estimatedStayDays}
          setEstimatedStayDays={setEstimatedStayDays}
          preflightRoomLimitRupees={verifyResult?.roomRentLimitRupees ?? null}
        />

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
                  DPDP Act 2023 consent capture
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

// ---------- T2-14 — Room & coverage card ----------

interface RoomCoverageCardProps {
  roomDailyRateRupees: string;
  setRoomDailyRateRupees: (v: string) => void;
  policyRoomRentLimitRupees: string;
  setPolicyRoomRentLimitRupees: (v: string) => void;
  estimatedStayDays: string;
  setEstimatedStayDays: (v: string) => void;
  // When the preflight returned a room-rent limit, show a hint badge
  // on the policy-limit field so the operator knows it was auto-filled
  // from the verified coverage rather than typed manually.
  preflightRoomLimitRupees: number | null;
}

function RoomCoverageCard({
  roomDailyRateRupees,
  setRoomDailyRateRupees,
  policyRoomRentLimitRupees,
  setPolicyRoomRentLimitRupees,
  estimatedStayDays,
  setEstimatedStayDays,
  preflightRoomLimitRupees,
}: RoomCoverageCardProps): JSX.Element {
  const rate = roomDailyRateRupees.trim() ? Number(roomDailyRateRupees) : null;
  const limit = policyRoomRentLimitRupees.trim() ? Number(policyRoomRentLimitRupees) : null;
  const days = estimatedStayDays.trim() ? Number(estimatedStayDays) : null;
  // Pre-warn only renders when both ends of the comparison are typed
  // and parsed as finite non-negative numbers. Math mirrors the
  // server-side helper apps/api/src/modules/case/room-rent-liability.ts.
  const canCompute =
    rate !== null && limit !== null && Number.isFinite(rate) && Number.isFinite(limit);
  const perDayLiability = canCompute ? Math.max(0, rate - limit) : null;
  const totalLiability =
    perDayLiability !== null && days !== null && Number.isFinite(days)
      ? perDayLiability * days
      : null;
  const isOverLimit = perDayLiability !== null && perDayLiability > 0;

  return (
    <fieldset className="glass rounded-xl p-6">
      <div className="mb-2 flex items-center gap-2">
        <span className="material-symbols-outlined text-primary">bed</span>
        <h3 className="text-h3 font-h3 text-on-surface">Room &amp; coverage</h3>
      </div>
      <p className="mb-4 text-body-sm text-on-surface-variant">
        Optional, strongly recommended for planned admissions. Catches room-rent
        sub-limit shortfalls so the family is told the out-of-pocket BEFORE
        admission, not at discharge.
      </p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="room-rate" className={LABEL_CLS}>
            Room daily rate (₹)
          </label>
          <input
            id="room-rate"
            inputMode="numeric"
            value={roomDailyRateRupees}
            onChange={(e) => setRoomDailyRateRupees(e.target.value.replace(/[^0-9.]/g, ''))}
            placeholder="e.g. 8000"
            className={`${INPUT_CLS} font-mono tabular-nums`}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="policy-limit" className={LABEL_CLS}>
            Policy room-rent cap (₹/day)
          </label>
          <input
            id="policy-limit"
            inputMode="numeric"
            value={policyRoomRentLimitRupees}
            onChange={(e) =>
              setPolicyRoomRentLimitRupees(e.target.value.replace(/[^0-9.]/g, ''))
            }
            placeholder="e.g. 5000 — auto-fills from coverage check"
            className={`${INPUT_CLS} font-mono tabular-nums`}
          />
          {preflightRoomLimitRupees !== null ? (
            <span className="mt-1 text-[11px] uppercase tracking-eyebrow text-primary">
              Auto-filled from coverage check
            </span>
          ) : null}
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="stay-days" className={LABEL_CLS}>
            Estimated stay (days)
          </label>
          <input
            id="stay-days"
            inputMode="numeric"
            value={estimatedStayDays}
            onChange={(e) => setEstimatedStayDays(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder="e.g. 5"
            className={`${INPUT_CLS} font-mono tabular-nums`}
          />
        </div>
      </div>

      {/* Live pre-warn — only when both rate + limit typed */}
      {canCompute ? (
        isOverLimit ? (
          <div
            className="mt-5 rounded-lg border border-amber-200 bg-amber-50/80 p-4"
            role="alert"
            aria-live="polite"
          >
            <div className="flex items-start gap-3">
              <span className="material-symbols-outlined mt-0.5 text-amber-700">warning</span>
              <div className="flex-1 text-body-sm text-on-surface">
                <p className="font-medium">
                  Room rate exceeds policy cap by ₹{fmtINR(perDayLiability!)}/day.
                </p>
                <p className="mt-1 text-on-surface-variant">
                  Family is liable for the differential each day
                  {totalLiability !== null ? (
                    <>
                      {' '}
                      — projected total over {days} day{days === 1 ? '' : 's'}:{' '}
                      <span className="font-bold text-on-surface">
                        ₹{fmtINR(totalLiability)}
                      </span>
                    </>
                  ) : null}
                  . Most Indian policies also apply a proportionate deduction on
                  associated services. Obtain explicit acceptance (or move to a
                  cheaper room) before admission.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-5 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 text-body-sm text-emerald-800">
            <span className="material-symbols-outlined text-emerald-700">check_circle</span>
            <span>Room rate is within the policy cap. No room-rent shortfall.</span>
          </div>
        )
      ) : null}
    </fieldset>
  );
}

function fmtINR(rupees: number): string {
  return rupees.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

