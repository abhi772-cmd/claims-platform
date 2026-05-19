'use client';

// Unified identity discovery widget. Phase 1 of the 4-phase plan
// (see docs/design/identity-discovery-plan.md). Replaces the older
// pattern of scattered identifier inputs (Aadhaar, ABHA, mobile,
// policy number) on /cases/new with a single "Find patient" affordance
// that routes the lookup to the right backend based on (identifierType,
// rail).
//
// Routing matrix:
//
//   Identifier kind   NHCX rail                        PMJAY rail
//   ---------------   -------------------------------  --------------------------
//   Mobile            Disabled — most NHCX payers      /pmjay/policies/lookup
//                     don't expose mobile lookup (a
//                     few do — Phase 3 adds per-payer
//                     opt-in)
//   ABHA              /eligibility/verify-by-          /pmjay/policies/lookup
//                     identifiers (abhaId)
//   Aadhaar           /eligibility/verify-by-          /pmjay/policies/lookup
//                     identifiers (aadhaar)            (Aadhaar -> derived ABHA;
//                                                       caller can also fall
//                                                       through to a coverage
//                                                       verify)
//   Policy number     /eligibility/verify-by-          /eligibility/verify-by-
//                     identifiers (policyNumber)       identifiers
//
// "Patient walks in with nothing" path: Generate ABHA via Aadhaar OTP
// is a Phase 2 stub here — renders the button but opens a "Coming soon"
// modal that documents the ABDM flow we'll wire next.

import {
  type PmjayPolicy,
  type VerifyCoverageByIdentifiersResponse,
} from '@claims/contracts';
import { useCallback, useState } from 'react';

import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';
import { useToast } from '../toast/ToastProvider';
import { EligibilityApi } from '../../lib/api/eligibility.api';
import { PmjayPoliciesApi } from '../../lib/api/pmjay-policies.api';

type IdentifierKind = 'mobile' | 'abha' | 'aadhaar' | 'policy';
type Rail = 'nhcx' | 'pmjay' | 'self_pay';

export interface DiscoveredIdentity {
  // Which identifier the operator typed. Drives the auto-fill below.
  identifierKind: IdentifierKind;
  identifierValue: string;
  // For PMJAY policies lookup the chosen policy supplies these.
  // For NHCX verify-by-identifiers the operator already picked a payer
  // upstream and the API confirms it; we still surface the inputs so
  // the parent form can fill the matching fields.
  payerCode?: string;
  policyNumber?: string;
  productName?: string;
  // For NHCX verifies, we also surface the synchronous benefits so the
  // parent form can auto-fill the room-rent pre-warn fields.
  verifyResult?: VerifyCoverageByIdentifiersResponse;
}

interface Props {
  rail: Rail;
  // The operator already picked a payer upstream for NHCX; PMJAY infers
  // the payer from the picked policy. Pass null when payer isn't chosen
  // yet — verify-by-identifiers calls will be gated.
  payerCode: string | null;
  // Phase 3 — when true, the chosen NHCX payer accepts the mobile-only
  // discovery call (/eligibility/discover-by-mobile). Driven by the
  // payer master row's supportsDiscoveryByMobile flag. Default false
  // for back-compat with existing callers.
  payerSupportsMobile?: boolean;
  // Captured patient context required by verify-by-identifiers.
  patientName: string;
  hospitalMrn: string;
  serviceDate: string | null;
  // Once an identity is discovered, the parent fills the form fields.
  onIdentityDiscovered: (identity: DiscoveredIdentity) => void;
}

const ABHA_PATTERN = /^\d{14}$/;
const MOBILE_PATTERN = /^\d{10}$/;
const AADHAAR_PATTERN = /^\d{12}$/;

const LABEL_CLS =
  'mb-1 block text-eyebrow uppercase tracking-eyebrow text-on-surface-variant';

export function IdentityDiscovery({
  rail,
  payerCode,
  payerSupportsMobile = false,
  patientName,
  hospitalMrn,
  serviceDate,
  onIdentityDiscovered,
}: Props): JSX.Element {
  const { showApiError } = useErrorModal();
  const showToast = useToast();
  const [kind, setKind] = useState<IdentifierKind>(rail === 'pmjay' ? 'abha' : 'policy');
  const [value, setValue] = useState('');
  const [looking, setLooking] = useState(false);
  const [validationMsg, setValidationMsg] = useState<string | null>(null);
  const [pmjayResults, setPmjayResults] = useState<PmjayPolicy[] | null>(null);
  const [abhaModalOpen, setAbhaModalOpen] = useState(false);

  // Mobile is supported either for PMJAY (always) or for NHCX payers
  // that have opted in via the payer master's supportsDiscoveryByMobile
  // flag (Phase 3).
  const mobileSupported = rail === 'pmjay' || (rail === 'nhcx' && payerSupportsMobile);
  const verifySupported = rail !== 'self_pay';

  const localValidate = useCallback(
    (k: IdentifierKind, v: string): string | null => {
      if (!v) return 'Enter a value to search.';
      if (k === 'abha' && !ABHA_PATTERN.test(v))
        return 'ABHA must be 14 digits, no hyphens.';
      if (k === 'mobile' && !MOBILE_PATTERN.test(v))
        return 'Mobile must be 10 digits.';
      if (k === 'aadhaar' && !AADHAAR_PATTERN.test(v))
        return 'Aadhaar must be 12 digits.';
      if (k === 'policy' && v.length < 4)
        return 'Policy number looks too short.';
      return null;
    },
    [],
  );

  const onChangeKind = useCallback(
    (next: IdentifierKind) => {
      setKind(next);
      setValue('');
      setValidationMsg(null);
      setPmjayResults(null);
    },
    [],
  );

  const search = useCallback(async (): Promise<void> => {
    const msg = localValidate(kind, value);
    if (msg) {
      setValidationMsg(msg);
      return;
    }
    setValidationMsg(null);

    // PMJAY routes via policies-lookup for mobile + ABHA. Aadhaar +
    // policy fall through to the standard verify-by-identifiers since
    // PMJAY beneficiaries also have those, but the policies-lookup
    // surface is mobile/ABHA only at the gateway level.
    const usePmjayLookup =
      rail === 'pmjay' && (kind === 'mobile' || kind === 'abha');

    setLooking(true);
    try {
      if (usePmjayLookup) {
        const res = await PmjayPoliciesApi.lookup({
          identifierType: kind === 'mobile' ? 'mobile' : 'abha',
          identifier: value,
        });
        setPmjayResults(res.policies);
        if (res.policies.length === 0) {
          showToast({
            tone: 'warning',
            message: `No PMJAY policy found for the supplied ${kind === 'mobile' ? 'mobile number' : 'ABHA'}.`,
          });
        }
        return;
      }

      // Phase 3 — NHCX mobile-based discovery. The chosen payer must
      // carry supportsDiscoveryByMobile=true on the master row; the
      // API rejects others with a friendly 422. Result auto-fills
      // policyNumber (when the payer matched) so the operator can
      // immediately run a regular verify-by-identifiers afterwards.
      if (rail === 'nhcx' && kind === 'mobile') {
        if (!payerCode) {
          setValidationMsg('Pick a payer above before running the lookup.');
          return;
        }
        if (!payerSupportsMobile) {
          setValidationMsg(
            'This payer does not support mobile discovery. Use ABHA, Aadhaar, or policy number.',
          );
          return;
        }
        const res = await EligibilityApi.discoverByMobile({
          payerCode,
          mobile: value,
          ...(patientName.trim() ? { patientName } : {}),
          ...(hospitalMrn.trim() ? { hospitalMrn } : {}),
        });
        if (res.verified && res.policyNumber) {
          onIdentityDiscovered({
            identifierKind: 'mobile',
            identifierValue: value,
            payerCode,
            policyNumber: res.policyNumber,
            ...(res.planName !== null ? { productName: res.planName } : {}),
          });
          showToast({
            tone: 'success',
            message: `Found policy ${res.policyNumber} on ${res.planName ?? 'this payer'}.`,
          });
        } else {
          showToast({
            tone: 'warning',
            message: `No policy found for mobile ${value} on this payer: ${res.failureReason ?? 'unknown'}.`,
          });
        }
        return;
      }

      // verify-by-identifiers path. Requires payerCode + patient inputs.
      if (!verifySupported) {
        setValidationMsg('Self-pay rail does not need a coverage lookup.');
        return;
      }
      if (!payerCode) {
        setValidationMsg('Pick a payer above before running the lookup.');
        return;
      }
      if (!patientName.trim() || !hospitalMrn.trim()) {
        setValidationMsg('Patient name and MRN are required before lookup.');
        return;
      }
      const verify = await EligibilityApi.verifyByIdentifiers({
        patientName,
        hospitalMrn,
        payerCode,
        ...(kind === 'policy' ? { policyNumber: value } : {}),
        ...(kind === 'abha' ? { abhaId: value } : {}),
        ...(kind === 'aadhaar' ? { aadhaar: value } : {}),
        ...(serviceDate ? { serviceDate } : {}),
      });
      onIdentityDiscovered({
        identifierKind: kind,
        identifierValue: value,
        payerCode,
        ...(verify.planName !== null ? { productName: verify.planName } : {}),
        verifyResult: verify,
      });
      showToast({
        tone: verify.verified ? 'success' : 'warning',
        message: verify.verified
          ? `Coverage verified — ${verify.planName ?? 'plan details'} ready.`
          : `Coverage check failed: ${verify.failureReason ?? 'see result panel.'}`,
      });
    } catch (err) {
      showApiError(err);
    } finally {
      setLooking(false);
    }
  }, [
    hospitalMrn,
    kind,
    localValidate,
    onIdentityDiscovered,
    patientName,
    payerCode,
    payerSupportsMobile,
    rail,
    serviceDate,
    showApiError,
    showToast,
    value,
    verifySupported,
  ]);

  const onPickPmjayPolicy = useCallback(
    (policy: PmjayPolicy) => {
      onIdentityDiscovered({
        identifierKind: kind,
        identifierValue: value,
        payerCode: policy.payerId,
        policyNumber: policy.policyNumber,
        productName: policy.productName,
      });
      setPmjayResults(null);
    },
    [kind, onIdentityDiscovered, value],
  );

  return (
    <div className="glass rounded-xl p-6">
      <div className="mb-2 flex items-center gap-2">
        <span className="material-symbols-outlined text-primary">person_search</span>
        <h3 className="text-h3 font-h3 text-on-surface">Find patient</h3>
      </div>
      <p className="mb-4 text-body-sm text-on-surface-variant">
        Search by mobile, ABHA, Aadhaar, or policy number. The platform
        routes the lookup to the right gateway based on the rail.
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[160px_1fr_auto]">
        <div>
          <label className={LABEL_CLS} htmlFor="identity-kind">Identifier</label>
          <select
            id="identity-kind"
            value={kind}
            onChange={(e) => onChangeKind(e.target.value as IdentifierKind)}
            className="glass-input"
            disabled={looking}
          >
            <option value="mobile" disabled={!mobileSupported}>
              Mobile {!mobileSupported ? '— Phase 3' : ''}
            </option>
            <option value="abha">ABHA</option>
            <option value="aadhaar">Aadhaar</option>
            <option value="policy">Policy number</option>
          </select>
        </div>
        <div>
          <label className={LABEL_CLS} htmlFor="identity-value">
            {kind === 'mobile'
              ? '10-digit mobile'
              : kind === 'abha'
                ? '14-digit ABHA'
                : kind === 'aadhaar'
                  ? '12-digit Aadhaar'
                  : 'Policy number'}
          </label>
          <input
            id="identity-value"
            value={value}
            onChange={(e) => {
              setValue(e.target.value.replace(/\s+/g, ''));
              setValidationMsg(null);
            }}
            inputMode={kind === 'policy' ? 'text' : 'numeric'}
            maxLength={kind === 'abha' ? 14 : kind === 'aadhaar' ? 12 : kind === 'mobile' ? 10 : 64}
            placeholder={
              kind === 'mobile'
                ? '9876543210'
                : kind === 'abha'
                  ? '14004567891234'
                  : kind === 'aadhaar'
                    ? '123412341234'
                    : 'POL-XXXX-XXXX'
            }
            className="glass-input tabular-nums"
            disabled={looking}
            aria-invalid={validationMsg !== null}
          />
          {validationMsg ? (
            <p className="mt-1 text-body-sm text-error">{validationMsg}</p>
          ) : null}
        </div>
        <div className="flex items-end">
          <button
            type="button"
            onClick={() => void search()}
            disabled={looking || value.length === 0}
            className="btn-cta whitespace-nowrap"
          >
            {looking ? 'Searching…' : 'Find'}
          </button>
        </div>
      </div>

      {pmjayResults !== null ? (
        <PmjayResultsPanel results={pmjayResults} onPick={onPickPmjayPolicy} />
      ) : null}

      {/* "No identifier at all" escape hatch — Phase 2 will wire the
          real ABDM flow. */}
      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-outline-variant/40 pt-4">
        <span className="text-body-sm text-on-surface-variant">
          Patient has no identifier?
        </span>
        <button
          type="button"
          onClick={() => setAbhaModalOpen(true)}
          className="btn-outline"
        >
          Generate ABHA via Aadhaar OTP
        </button>
        <span className="text-body-sm text-on-surface-variant">
          (or ask them to call the insurer&apos;s helpline for the policy number)
        </span>
      </div>

      {abhaModalOpen ? <AbhaComingSoonModal onClose={() => setAbhaModalOpen(false)} /> : null}
    </div>
  );
}

function PmjayResultsPanel({
  results,
  onPick,
}: {
  results: PmjayPolicy[];
  onPick: (p: PmjayPolicy) => void;
}): JSX.Element {
  if (results.length === 0) {
    return (
      <div className="mt-5 rounded-lg border border-warning-500/30 bg-warning-50/60 px-4 py-3">
        <p className="text-body-sm text-on-surface">
          No PMJAY policy found. Confirm the beneficiary is enrolled, or
          generate an ABHA via Aadhaar OTP below.
        </p>
      </div>
    );
  }
  return (
    <div className="mt-5">
      <div className="mb-2 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
        {results.length === 1 ? '1 policy found' : `${results.length} policies — pick one`}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {results.map((p) => (
          <button
            key={`${p.payerId}-${p.policyNumber}`}
            type="button"
            onClick={() => onPick(p)}
            className="glass rounded-lg px-4 py-3 text-left transition hover:-translate-y-px"
          >
            <div className="text-h3 font-semibold text-on-surface">
              {p.productName}
            </div>
            <div className="mt-1 text-body-sm text-on-surface-variant tabular-nums">
              Member {p.memberId} · Policy {p.policyNumber}
            </div>
            <div className="mt-2 inline-flex items-center gap-1 text-eyebrow uppercase tracking-eyebrow text-primary">
              Pick policy →
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// Placeholder modal — Phase 2 replaces this with the real ABDM flow.
function AbhaComingSoonModal({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-on-surface/40 backdrop-blur-sm">
      <div className="glass-strong w-[min(540px,calc(100%-32px))] rounded-xl p-6">
        <h4 className="mb-1 text-h3 font-semibold text-on-surface">
          Generate ABHA via Aadhaar OTP
        </h4>
        <p className="mb-3 text-body-sm text-on-surface-variant">
          Phase 2 wires the ABDM API for creating a new ABHA on the
          patient&apos;s behalf:
        </p>
        <ol className="mb-4 space-y-1 pl-5 text-body-sm text-on-surface list-decimal">
          <li>Operator enters the patient&apos;s Aadhaar</li>
          <li>ABDM sends an OTP to the registered mobile</li>
          <li>Patient reads the OTP back to the operator</li>
          <li>ABDM returns a fresh ABHA ID</li>
          <li>UI auto-fills and re-runs the policies lookup</li>
        </ol>
        <p className="mb-4 text-body-sm text-on-surface-variant">
          Coming next — see the multi-phase plan.
        </p>
        <div className="flex justify-end">
          <button type="button" onClick={onClose} className="btn-cta">
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
