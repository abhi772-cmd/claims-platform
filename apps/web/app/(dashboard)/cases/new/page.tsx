'use client';

// Slice CF — intake-flow consent capture (Stitch-canonical layout).
//
// Three glass cards: Case Details · Identity & PII · DPDP Consent Capture.
// Consent defaults are derived from the primary rail:
//   nhcx     → consentType=nhcx_processing
//   pmjay    → consentType=pmjay_processing
//   self_pay → no consent block (no rail-driven processing happens)

import {
  type AcknowledgementMethod,
  type ConsentType,
  CreateCaseRequestSchema,
  type IntakeConsent,
  type Payer,
  type PatientPiiInput,
  type PayerCommercialTerms,
  type PmjayPolicy,
  type ResolvedRoomCategory,
  type VerifyCoverageByIdentifiersResponse,
} from '@claims/contracts';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { CoverageDetailsCard } from '../../../../components/identity/CoverageDetailsCard';
import { IdentityDiscovery, type DiscoveredIdentity } from '../../../../components/identity/IdentityDiscovery';
import { useErrorModal } from '../../../../components/modals/ErrorModal/ErrorModalProvider';
import { PolicySelector } from '../../../../components/pmjay/PolicySelector';
import { CaseApi } from '../../../../lib/api/case.api';
import { ConsentApi } from '../../../../lib/api/consent.api';
import { TenantPayerApi } from '../../../../lib/api/tenant-payer.api';
import { PayerCommercialTermsApi } from '../../../../lib/api/payer-commercial-terms.api';
import { RoomCategoryApi } from '../../../../lib/api/room-category.api';

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
  // Tracks which identifiers were filled by the Find-patient widget vs.
  // typed by the operator. Drives the "Auto-filled from search" hint
  // beneath the matching input. Cleared per-field whenever the operator
  // edits the value by hand.
  const [autoFilledFromSearch, setAutoFilledFromSearch] = useState<{
    aadhaar: boolean;
    abha: boolean;
    mobile: boolean;
  }>({ aadhaar: false, abha: false, mobile: false });

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

  // PR C — room rate catalog + commercial terms.
  // Categories include the resolved payer-override rate when payerCode
  // is set; null payerCode means show defaults only. Commercial terms
  // drive the out-of-pocket pre-warn (co-pay + deductible).
  const [roomCategories, setRoomCategories] = useState<ResolvedRoomCategory[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('');
  const [commercialTerms, setCommercialTerms] = useState<PayerCommercialTerms | null>(null);

  // Consent capture (Slice CM — three-method picker)
  const [captureConsent, setCaptureConsent] = useState(true);
  const [noticeText, setNoticeText] = useState(DEFAULT_NOTICE_TEXT);
  // Selected method drives which sub-panel renders + which evidence
  // shape is built into the submit payload. Default is null so the
  // operator MUST pick one (the panels are gated by mobile / abhaId
  // presence — see methodAvailability below).
  const [consentMethod, setConsentMethod] = useState<AcknowledgementMethod | null>(null);

  // OTP method state.
  const [otpId, setOtpId] = useState<string | null>(null);
  const [otpMobileLast4, setOtpMobileLast4] = useState<string | null>(null);
  const [otpExpiresAt, setOtpExpiresAt] = useState<string | null>(null);
  const [otpVerifiedAt, setOtpVerifiedAt] = useState<string | null>(null);
  const [otpSentAt, setOtpSentAt] = useState<string | null>(null);
  const [otpCode, setOtpCode] = useState('');
  const [otpSending, setOtpSending] = useState(false);
  const [otpVerifying, setOtpVerifying] = useState(false);

  // Emergency / verbal-countersigned state.
  const [verbalReason, setVerbalReason] = useState<
    | 'emergency_admission'
    | 'patient_unable_to_sign'
    | 'illiterate_thumbprint'
    | 'mobile_unavailable'
    | 'other'
  >('emergency_admission');
  const [verbalTranscript, setVerbalTranscript] = useState('');

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
    // Slice CN — the dropdown now shows only the payers THIS tenant has
    // empanelled (active), not the whole platform registry. Filter to
    // the current rail and map the empanelled shape onto Payer so the
    // identity widget below keeps its existing prop type.
    TenantPayerApi.listEmpanelled()
      .then((res) => {
        if (cancelled) return;
        const mapped: Payer[] = res.payers
          .filter((p) => p.rail === primaryRail)
          .map((p) => ({
            id: p.payerId,
            code: p.code,
            name: p.name,
            payerType: p.payerType,
            rail: p.rail,
            hcxCode: p.hcxCode,
            active: p.active,
            supportsDiscoveryByMobile: p.supportsDiscoveryByMobile,
            effectiveFrom: p.empanelledAt,
            effectiveTo: null,
          }));
        setPayers(mapped);
      })
      .catch((err: unknown) => {
        if (!cancelled) showApiError(err);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryRail]);

  // PR C — load resolved room categories. Refetches whenever payerCode
  // changes so the dropdown reflects the current payer's negotiated
  // rates; falls back to the catalog defaults when no payer is set
  // (or self-pay).
  useEffect(() => {
    let cancelled = false;
    const code = payerCode.trim() ? payerCode.trim() : undefined;
    RoomCategoryApi.list(code ? { payerCode: code } : undefined)
      .then((res) => {
        if (cancelled) return;
        setRoomCategories(res.categories);
      })
      .catch(() => {
        // Catalog is empty or API not yet wired — keep the legacy
        // free-text fallback by leaving categories as [].
        if (!cancelled) setRoomCategories([]);
      });
    return () => {
      cancelled = true;
    };
  }, [payerCode]);

  // PR C — load this payer's commercial terms when payer is known.
  // Drives the out-of-pocket pre-warn. 404 = "no terms yet" → keep
  // commercialTerms null so the tile self-hides.
  useEffect(() => {
    let cancelled = false;
    const code = payerCode.trim();
    if (!code) {
      setCommercialTerms(null);
      return () => {
        cancelled = true;
      };
    }
    PayerCommercialTermsApi.get(code)
      .then((t) => {
        if (!cancelled) setCommercialTerms(t);
      })
      .catch(() => {
        if (!cancelled) setCommercialTerms(null);
      });
    return () => {
      cancelled = true;
    };
  }, [payerCode]);

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

    // Build the IntakeConsent payload from the selected method. Each
    // method produces a distinct `source` / `acknowledgementMethod` /
    // `acknowledgementRef` / evidence sub-payload triple.
    let consent: IntakeConsent | undefined;
    if (captureConsent && consentApplicable && patient && consentMethod !== null) {
      const baseEvidence = {
        noticeText,
        locales: ['en-IN'] as string[],
      };
      const baseConsent = {
        consentType,
        dataCategories: Object.keys(patient),
        purposes:
          primaryRail === 'pmjay'
            ? ['eligibility.verify', 'preauth.submit', 'claim.submit']
            : ['eligibility.verify', 'preauth.submit', 'claim.submit', 'communication.send'],
        lawfulBasis: 'consent' as const,
      };

      if (consentMethod === 'otp') {
        if (!otpId || !otpVerifiedAt || !otpSentAt || !otpMobileLast4) {
          showError(
            'VALIDATION_FAILED',
            'OTP must be sent and verified before creating the case.',
          );
          return;
        }
        consent = {
          ...baseConsent,
          source: `consent_otp:${otpId}`,
          acknowledgementMethod: 'otp',
          acknowledgementRef: otpId,
          evidence: {
            ...baseEvidence,
            acknowledgedVia: 'otp',
            otp: {
              otpId,
              mobileLast4: otpMobileLast4,
              sentAt: otpSentAt,
              verifiedAt: otpVerifiedAt,
              gatewayMessageId: null,
            },
          },
        };
      } else if (consentMethod === 'verbal_countersigned') {
        if (verbalTranscript.trim().length < 5) {
          showError(
            'VALIDATION_FAILED',
            'Verbal transcript is required (what the patient said).',
          );
          return;
        }
        const capturedAt = new Date().toISOString();
        // 24-hour deadline for counter-sign. Until that's uploaded the
        // status sits at 'pending_countersign' (sweeper not built yet;
        // for now the consent_record commits as 'granted' and the
        // sweeper PR adds the state-machine guard).
        const countersignDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        consent = {
          ...baseConsent,
          source: `verbal_countersigned:${verbalReason}`,
          acknowledgementMethod: 'verbal_countersigned',
          evidence: {
            ...baseEvidence,
            acknowledgedVia: 'verbal_countersigned',
            verbal: {
              // Operator (witness 1) — backend overrides with the
              // session userId. Placeholder zeros pass UUID validation;
              // server-side capture sets the real value.
              witness1UserId: '00000000-0000-0000-0000-000000000000',
              witness2UserId: '00000000-0000-0000-0000-000000000000',
              reasonCode: verbalReason,
              verbalTranscript: verbalTranscript.trim(),
              capturedAt,
              countersignDeadline,
            },
          },
        };
      } else {
        // ABHA path lands when wired; for now the button is disabled
        // and we should never reach this branch.
        showError(
          'VALIDATION_FAILED',
          'ABHA Consent Manager not yet available — pick OTP or Emergency.',
        );
        return;
      }
    }

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
              if (identity.identifierKind === 'abha') {
                setAbhaId(identity.identifierValue);
                setAutoFilledFromSearch((prev) => ({ ...prev, abha: true }));
              }
              if (identity.identifierKind === 'aadhaar') {
                setAadhaar(identity.identifierValue);
                setAutoFilledFromSearch((prev) => ({ ...prev, aadhaar: true }));
              }
              if (identity.identifierKind === 'mobile') {
                setMobile(identity.identifierValue);
                setAutoFilledFromSearch((prev) => ({ ...prev, mobile: true }));
              }
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
            room rate AND policy limit are typed.
            PR C — passes room catalog + commercial terms so the
            card can render the dropdown picker and the out-of-pocket
            tile. */}
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
          roomCategories={roomCategories}
          selectedCategoryId={selectedCategoryId}
          onCategoryChange={(id) => {
            setSelectedCategoryId(id);
            const cat = roomCategories.find((c) => c.id === id);
            if (cat) {
              setRoomDailyRateRupees(String(Math.round(cat.effectiveRatePaise / 100)));
            }
          }}
          commercialTerms={commercialTerms}
          admissionType={admissionType}
        />

        {/* Card 2: Review & complete identifiers
            Find-patient auto-fills whichever identifier the operator
            searched by (and the policy number it returns). This card
            is where they review those auto-filled values and complete
            anything the search didn't supply — most often the mobile
            number, since communication.send needs it even when discovery
            used ABHA or Aadhaar. */}
        <fieldset className="glass rounded-xl p-6">
          <div className="mb-6 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary">badge</span>
              <h3 className="text-h3 font-h3 text-on-surface">Review &amp; complete identifiers</h3>
            </div>
            <span className="rounded bg-primary-fixed-dim/20 px-2 py-1 text-eyebrow uppercase tracking-eyebrow text-primary">
              Secure
            </span>
          </div>
          <p className="mb-4 text-body-sm text-on-surface-variant">
            Auto-filled from Find patient where applicable. Add any missing identifiers —
            mobile is required for communication. Stored AES-256-GCM encrypted with the
            per-tenant DEK.
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
                onChange={(e) => {
                  setAadhaar(e.target.value);
                  if (autoFilledFromSearch.aadhaar) {
                    setAutoFilledFromSearch((prev) => ({ ...prev, aadhaar: false }));
                  }
                }}
                placeholder="XXXX XXXX XXXX"
                className={`${INPUT_CLS} font-mono tracking-widest`}
              />
              {autoFilledFromSearch.aadhaar ? (
                <span className="mt-1 text-[11px] uppercase tracking-eyebrow text-primary">
                  Auto-filled from search
                </span>
              ) : null}
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="abha" className={LABEL_CLS}>
                ABHA ID
              </label>
              <input
                id="abha"
                value={abhaId}
                onChange={(e) => {
                  setAbhaId(e.target.value);
                  if (autoFilledFromSearch.abha) {
                    setAutoFilledFromSearch((prev) => ({ ...prev, abha: false }));
                  }
                }}
                placeholder="XX-XXXX-XXXX-XXXX"
                className={`${INPUT_CLS} font-mono tracking-widest`}
              />
              {autoFilledFromSearch.abha ? (
                <span className="mt-1 text-[11px] uppercase tracking-eyebrow text-primary">
                  Auto-filled from search
                </span>
              ) : null}
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
                  onChange={(e) => {
                    setMobile(e.target.value);
                    if (autoFilledFromSearch.mobile) {
                      setAutoFilledFromSearch((prev) => ({ ...prev, mobile: false }));
                    }
                  }}
                  placeholder="XXXXX XXXXX"
                  className={`${INPUT_CLS} rounded-l-none font-mono`}
                />
              </div>
              {autoFilledFromSearch.mobile ? (
                <span className="mt-1 text-[11px] uppercase tracking-eyebrow text-primary">
                  Auto-filled from search
                </span>
              ) : null}
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

              {captureConsent && (
                <ConsentMethodPicker
                  selected={consentMethod}
                  onSelect={setConsentMethod}
                  hasMobile={mobile.trim().length > 0}
                  hasAbha={abhaId.trim().length > 0}
                />
              )}

              {captureConsent && consentMethod === 'otp' && (
                <OtpCapturePanel
                  mobile={mobile}
                  consentType={consentType}
                  noticeText={noticeText}
                  otpId={otpId}
                  otpMobileLast4={otpMobileLast4}
                  otpExpiresAt={otpExpiresAt}
                  otpVerifiedAt={otpVerifiedAt}
                  otpCode={otpCode}
                  setOtpCode={setOtpCode}
                  sending={otpSending}
                  verifying={otpVerifying}
                  onSend={async () => {
                    setOtpSending(true);
                    try {
                      const r = await ConsentApi.otpInitiate({
                        mobile: mobile.replace(/\s+/g, ''),
                        consentType,
                        noticeText,
                        locales: ['en-IN'],
                      });
                      setOtpId(r.otpId);
                      setOtpMobileLast4(r.mobileLast4);
                      setOtpExpiresAt(r.expiresAt);
                      setOtpSentAt(new Date().toISOString());
                      setOtpVerifiedAt(null);
                      setOtpCode('');
                    } catch (err) {
                      showApiError(err);
                    } finally {
                      setOtpSending(false);
                    }
                  }}
                  onVerify={async () => {
                    if (!otpId) return;
                    setOtpVerifying(true);
                    try {
                      const r = await ConsentApi.otpVerify({
                        otpId,
                        code: otpCode.trim(),
                      });
                      setOtpVerifiedAt(r.verifiedAt);
                    } catch (err) {
                      showApiError(err);
                    } finally {
                      setOtpVerifying(false);
                    }
                  }}
                />
              )}

              {captureConsent && consentMethod === 'verbal_countersigned' && (
                <VerbalCapturePanel
                  reason={verbalReason}
                  setReason={setVerbalReason}
                  transcript={verbalTranscript}
                  setTranscript={setVerbalTranscript}
                />
              )}

              {captureConsent && consentMethod === 'abha_hie_cm' && (
                <div className="rounded-lg border border-amber-300 bg-amber-50/60 p-4 text-body-sm text-amber-900">
                  <strong>ABHA Consent Manager flow is coming next sprint.</strong> For now use
                  OTP (recommended) or the emergency path. Once wired, the patient will receive
                  the consent request inside their ABHA app and approve from there — the
                  strongest legal artifact available under DPDP / ABDM.
                </div>
              )}
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
  // PR C — catalog dropdown + commercial terms for the out-of-pocket
  // tile. When categories is empty (tenant hasn't built a catalog yet)
  // the card falls back to the legacy free-text input.
  roomCategories: ResolvedRoomCategory[];
  selectedCategoryId: string;
  onCategoryChange: (id: string) => void;
  commercialTerms: PayerCommercialTerms | null;
  admissionType: 'planned' | 'emergency' | 'day_care';
}

function RoomCoverageCard({
  roomDailyRateRupees,
  setRoomDailyRateRupees,
  policyRoomRentLimitRupees,
  setPolicyRoomRentLimitRupees,
  estimatedStayDays,
  setEstimatedStayDays,
  preflightRoomLimitRupees,
  roomCategories,
  selectedCategoryId,
  onCategoryChange,
  commercialTerms,
  admissionType,
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
          {roomCategories.length > 0 ? (
            <>
              <div className="relative">
                <select
                  id="room-category"
                  value={selectedCategoryId}
                  onChange={(e) => onCategoryChange(e.target.value)}
                  className={`${INPUT_CLS} appearance-none pr-10`}
                >
                  <option value="">— pick a room category —</option>
                  {roomCategories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · ₹{Math.round(c.effectiveRatePaise / 100).toLocaleString('en-IN')}
                      {c.payerOverridePaise !== null
                        ? ` (negotiated · default ₹${Math.round(c.dailyRatePaise / 100).toLocaleString('en-IN')})`
                        : ''}
                    </option>
                  ))}
                </select>
                <span className="material-symbols-outlined pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant">
                  expand_more
                </span>
              </div>
              {selectedCategoryId ? (
                <span className="mt-1 text-[11px] uppercase tracking-eyebrow text-primary">
                  Auto-filled from catalog
                </span>
              ) : null}
            </>
          ) : (
            <input
              id="room-rate"
              inputMode="numeric"
              value={roomDailyRateRupees}
              onChange={(e) => setRoomDailyRateRupees(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="e.g. 8000"
              className={`${INPUT_CLS} font-mono tabular-nums`}
            />
          )}
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

      {/* Out-of-pocket pre-warn — PR C. Renders when payer commercial
          terms are loaded and the room rate is known. Combines co-pay,
          deductible, and room-rent shortfall into a single estimate so
          the family knows the upfront before admission. */}
      {commercialTerms && rate !== null ? (
        <OutOfPocketTile
          rate={rate}
          limit={limit}
          days={days}
          terms={commercialTerms}
          admissionType={admissionType}
        />
      ) : null}

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

// ────── PR C — Out-of-pocket pre-warn ─────────────────────────────
// Combines co-pay + deductible + room shortfall into one tile so the
// operator can quote the family before admission. All inputs are in
// rupees (rate, limit) for direct paise math against the terms.
function OutOfPocketTile({
  rate,
  limit,
  days,
  terms,
  admissionType,
}: {
  rate: number;            // rupees / day
  limit: number | null;    // rupees / day; null when not yet entered
  days: number | null;     // stay days; null when not yet entered
  terms: PayerCommercialTerms;
  admissionType: 'planned' | 'emergency' | 'day_care';
}): JSX.Element | null {
  const stayDays = days !== null && Number.isFinite(days) && days > 0 ? days : 1;
  const copayApplies =
    terms.copayAppliesTo === null ||
    terms.copayAppliesTo === 'both' ||
    (terms.copayAppliesTo === 'planned' && admissionType === 'planned') ||
    (terms.copayAppliesTo === 'emergency' && admissionType === 'emergency');

  // Co-pay: take the higher of percent-based or flat (some MOUs say
  // "10% capped at ₹50k" — the cap is the floor of what the patient
  // pays; without cap-handling here we use the larger of the two).
  let copayRupees = 0;
  if (copayApplies) {
    const billRupees = rate * stayDays;
    const fromPercent =
      terms.copayPercent !== null ? Math.round((billRupees * terms.copayPercent) / 100) : 0;
    const fromFlat =
      terms.copayFlatPaise !== null ? Math.round(terms.copayFlatPaise / 100) : 0;
    copayRupees = Math.max(fromPercent, fromFlat);
  }

  const deductibleRupees =
    terms.deductiblePaise !== null ? Math.round(terms.deductiblePaise / 100) : 0;

  const roomShortfallPerDay =
    limit !== null && Number.isFinite(limit) ? Math.max(0, rate - limit) : 0;
  const roomShortfallTotal = roomShortfallPerDay * stayDays;

  const total = copayRupees + deductibleRupees + roomShortfallTotal;

  // If every component is zero / unset, hide the tile — nothing useful
  // to show.
  if (total === 0 && copayRupees === 0 && deductibleRupees === 0) return null;

  return (
    <div className="mt-5 rounded-lg border border-primary/30 bg-primary-fixed/10 p-4">
      <div className="flex items-start gap-3">
        <span className="material-symbols-outlined mt-0.5 text-primary">
          account_balance_wallet
        </span>
        <div className="flex-1">
          <p className="text-body font-semibold text-on-surface">
            Family pays approximately ₹{fmtINR(total)} out-of-pocket
          </p>
          <p className="mt-0.5 text-[12px] text-on-surface-variant">
            Per the payer&apos;s commercial terms. Quote this BEFORE admission so
            the family signs in informed.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-2 text-body-sm md:grid-cols-3">
            <OopRow
              label="Co-pay"
              value={copayRupees}
              hint={
                !copayApplies
                  ? `Not applicable (${admissionType})`
                  : terms.copayPercent !== null && terms.copayFlatPaise !== null
                    ? `max of ${terms.copayPercent}% or ₹${fmtINR(Math.round(terms.copayFlatPaise / 100))}`
                    : terms.copayPercent !== null
                      ? `${terms.copayPercent}% of room cost`
                      : terms.copayFlatPaise !== null
                        ? `flat ₹${fmtINR(Math.round(terms.copayFlatPaise / 100))}`
                        : '—'
              }
            />
            <OopRow
              label="Deductible"
              value={deductibleRupees}
              hint={terms.deductibleScope ?? 'per admission'}
            />
            <OopRow
              label="Room shortfall"
              value={roomShortfallTotal}
              hint={
                roomShortfallPerDay > 0
                  ? `₹${fmtINR(roomShortfallPerDay)}/day × ${stayDays} day${stayDays === 1 ? '' : 's'}`
                  : limit === null
                    ? 'enter policy cap to compute'
                    : 'within cap'
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function OopRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint: string;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-outline-variant/30 bg-surface-container-lowest/40 px-3 py-2">
      <div className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
        {label}
      </div>
      <div className="text-body font-semibold tabular-nums text-on-surface">
        ₹{fmtINR(value)}
      </div>
      <div className="text-[11px] text-on-surface-variant">{hint}</div>
    </div>
  );
}

// Slice CM — consent capture sub-components.

function ConsentMethodPicker({
  selected,
  onSelect,
  hasMobile,
  hasAbha,
}: {
  selected: AcknowledgementMethod | null;
  onSelect: (m: AcknowledgementMethod) => void;
  hasMobile: boolean;
  hasAbha: boolean;
}): JSX.Element {
  const cards: Array<{
    method: AcknowledgementMethod;
    title: string;
    blurb: string;
    icon: string;
    available: boolean;
    badge?: string;
    note?: string;
  }> = [
    {
      method: 'abha_hie_cm',
      title: 'ABHA Consent Manager',
      blurb: 'Patient approves the request from their ABHA app — strongest legal artifact.',
      icon: 'verified_user',
      available: hasAbha,
      badge: hasAbha ? 'Recommended' : undefined,
      note: hasAbha ? undefined : 'Patient has no ABHA ID — capture in the Identity card first.',
    },
    {
      method: 'otp',
      title: 'OTP confirmation',
      blurb: 'Send a 6-digit code to the patient’s mobile. Patient reads it back; operator types it in.',
      icon: 'sms',
      available: hasMobile,
      note: hasMobile ? undefined : 'Patient mobile not provided — capture in the Identity card first.',
    },
    {
      method: 'verbal_countersigned',
      title: 'Emergency / verbal',
      blurb:
        'For unconscious, illiterate, or no-mobile patients. Two-witness verbal acknowledgement; counter-sign required within 24 h.',
      icon: 'emergency',
      available: true,
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      {cards.map((c) => {
        const isSelected = selected === c.method;
        return (
          <button
            key={c.method}
            type="button"
            disabled={!c.available}
            onClick={() => onSelect(c.method)}
            className={`group flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-all ${
              isSelected
                ? 'border-secondary-container bg-white shadow-md ring-2 ring-secondary-container'
                : 'border-white/60 bg-white/50 hover:border-secondary-container/60 hover:bg-white/70'
            } ${!c.available ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
          >
            <div className="flex w-full items-start justify-between gap-2">
              <span className="material-symbols-outlined text-[20px] text-secondary-container">
                {c.icon}
              </span>
              {c.badge ? (
                <span className="rounded-full bg-secondary-container/20 px-2 py-0.5 text-[10px] uppercase tracking-eyebrow text-secondary-container">
                  {c.badge}
                </span>
              ) : null}
            </div>
            <div className="text-body font-semibold text-on-surface">{c.title}</div>
            <div className="text-body-sm text-on-surface-variant">{c.blurb}</div>
            {c.note ? (
              <div className="mt-1 text-[11px] text-on-surface-variant/70">{c.note}</div>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function OtpCapturePanel({
  mobile,
  consentType,
  noticeText,
  otpId,
  otpMobileLast4,
  otpExpiresAt,
  otpVerifiedAt,
  otpCode,
  setOtpCode,
  sending,
  verifying,
  onSend,
  onVerify,
}: {
  mobile: string;
  consentType: ConsentType;
  noticeText: string;
  otpId: string | null;
  otpMobileLast4: string | null;
  otpExpiresAt: string | null;
  otpVerifiedAt: string | null;
  otpCode: string;
  setOtpCode: (s: string) => void;
  sending: boolean;
  verifying: boolean;
  onSend: () => void;
  onVerify: () => void;
}): JSX.Element {
  const expiresIn = otpExpiresAt
    ? Math.max(0, Math.round((new Date(otpExpiresAt).getTime() - Date.now()) / 1000))
    : null;
  const expired = expiresIn !== null && expiresIn <= 0;
  // Indirectly consumed so lint doesn't complain on the closure.
  void consentType;
  void noticeText;

  return (
    <div className="rounded-lg border border-white/50 bg-white/40 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-body font-semibold text-on-surface">
            OTP to mobile {mobile ? maskMobile(mobile) : '—'}
          </div>
          <div className="text-body-sm text-on-surface-variant">
            6-digit code, expires in 10 minutes. Patient reads it back; type it here to verify.
          </div>
        </div>
        <button
          type="button"
          onClick={onSend}
          disabled={sending || mobile.trim().length === 0 || otpVerifiedAt !== null}
          className="rounded-lg border border-secondary-container bg-white px-3 py-2 text-body-sm font-medium text-secondary-container hover:bg-secondary-container/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sending ? 'Sending…' : otpId ? 'Resend' : 'Send OTP'}
        </button>
      </div>

      {otpId && !otpVerifiedAt ? (
        <div className="mt-3 flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1">
            <label htmlFor="otpcode" className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
              Enter 6-digit code · sent to ****{otpMobileLast4}
              {expiresIn !== null && !expired ? ` · expires in ${formatMmSs(expiresIn)}` : ''}
              {expired ? ' · EXPIRED — resend' : ''}
            </label>
            <input
              id="otpcode"
              inputMode="numeric"
              maxLength={6}
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456"
              className="w-full rounded-lg border border-white bg-white/60 px-4 py-3 text-h3 font-mono tabular-nums tracking-widest text-on-surface placeholder:text-outline-variant outline-none focus:border-secondary-container focus:ring-1 focus:ring-secondary-container"
            />
          </div>
          <button
            type="button"
            onClick={onVerify}
            disabled={verifying || otpCode.length !== 6 || expired}
            className="rounded-lg bg-secondary-container px-4 py-3 text-body-sm font-medium text-white hover:bg-secondary-container/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {verifying ? 'Verifying…' : 'Verify'}
          </button>
        </div>
      ) : null}

      {otpVerifiedAt ? (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50/70 px-3 py-2 text-body-sm text-emerald-900">
          <span className="material-symbols-outlined text-[18px]">check_circle</span>
          OTP verified at {new Date(otpVerifiedAt).toLocaleTimeString()} — submit the case to bind
          the consent.
        </div>
      ) : null}
    </div>
  );
}

function VerbalCapturePanel({
  reason,
  setReason,
  transcript,
  setTranscript,
}: {
  reason:
    | 'emergency_admission'
    | 'patient_unable_to_sign'
    | 'illiterate_thumbprint'
    | 'mobile_unavailable'
    | 'other';
  setReason: (
    r:
      | 'emergency_admission'
      | 'patient_unable_to_sign'
      | 'illiterate_thumbprint'
      | 'mobile_unavailable'
      | 'other',
  ) => void;
  transcript: string;
  setTranscript: (s: string) => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-white/50 bg-white/40 p-4">
      <div className="rounded-md border border-amber-300 bg-amber-50/60 px-3 py-2 text-body-sm text-amber-900">
        <strong>Emergency path.</strong> You are witness 1. A second witness (any active staff
        user) and a counter-signed paper artifact are required within 24 hours; the case will
        flag for follow-up until counter-sign lands.
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="verbal-reason" className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
          Why verbal capture
        </label>
        <select
          id="verbal-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value as typeof reason)}
          className="w-full rounded-lg border border-white bg-white/60 px-4 py-3 text-body text-on-surface outline-none focus:border-secondary-container focus:ring-1 focus:ring-secondary-container"
        >
          <option value="emergency_admission">Emergency admission (patient unable to sign)</option>
          <option value="patient_unable_to_sign">Patient physically unable to sign</option>
          <option value="illiterate_thumbprint">Illiterate — thumbprint to follow</option>
          <option value="mobile_unavailable">No mobile available for OTP</option>
          <option value="other">Other (describe in transcript)</option>
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="verbal-transcript" className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
          What the patient / guardian said
        </label>
        <textarea
          id="verbal-transcript"
          rows={3}
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          placeholder="e.g., Guardian agreed — &quot;Haan theek hai, share kar do.&quot;"
          className="w-full rounded-lg border border-white bg-white/60 px-4 py-3 text-body text-on-surface placeholder:text-outline-variant outline-none focus:border-secondary-container focus:ring-1 focus:ring-secondary-container"
        />
      </div>
    </div>
  );
}

function maskMobile(m: string): string {
  const s = m.replace(/\s+/g, '');
  if (s.length <= 4) return s;
  return s.slice(0, -4).replace(/\d/g, '•') + s.slice(-4);
}

function formatMmSs(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

