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
  type AbhaCreateVerifyResponse,
  type IdentityDiscoverCandidate,
  type IdentityDiscoverResponse,
  type Payer,
  type PmjayPolicy,
  type PolicyMember,
  type VerifyCoverageByIdentifiersResponse,
} from '@claims/contracts';
import { useCallback, useState } from 'react';

import { AbhaCreator } from './AbhaCreator';
import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';
import { useToast } from '../toast/ToastProvider';
import { EligibilityApi } from '../../lib/api/eligibility.api';
import { IdentityDiscoverApi } from '../../lib/api/identity-discover.api';
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
  // Slice CO — when the operator picks a member off a family/group
  // policy roster, the parent form auto-fills the patient name + that
  // member's ABHA. Absent when the policy has no member roster.
  patientName?: string;
  abhaNumber?: string;
}

interface Props {
  rail: Rail;
  // Master-data payer list filtered to the current rail. Find patient
  // renders its own payer dropdown so the operator picks the payer
  // and the identifier in one place (replaces the separate Verify
  // coverage card). PMJAY rail can ignore this when searching by
  // mobile/ABHA — the picked policy supplies the payer.
  payers: Payer[];
  // Currently-picked payer code (lifted to parent state). When the
  // operator changes the dropdown, IdentityDiscovery calls onPayerChange
  // so the parent can refresh derived state (form fields, submit gate).
  payerCode: string | null;
  onPayerChange: (code: string) => void;
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
  payers,
  payerCode,
  onPayerChange,
  patientName,
  hospitalMrn,
  serviceDate,
  onIdentityDiscovered,
}: Props): JSX.Element {
  const { showApiError } = useErrorModal();
  const showToast = useToast();
  const [mode, setMode] = useState<'single' | 'smart'>('single');
  const [kind, setKind] = useState<IdentifierKind>(rail === 'pmjay' ? 'abha' : 'policy');
  const [value, setValue] = useState('');
  const [looking, setLooking] = useState(false);
  const [validationMsg, setValidationMsg] = useState<string | null>(null);
  const [pmjayResults, setPmjayResults] = useState<PmjayPolicy[] | null>(null);
  // Slice CO — unified member-roster picker, used by BOTH the PMJAY
  // policy flow and the NHCX verify flow. Set when a lookup/verify
  // returns members[]; holds the title + roster + the base identity to
  // finalise once a member is chosen. Cleared on selection or when a
  // member-less result finalises immediately.
  const [pendingMemberPick, setPendingMemberPick] = useState<{
    title: string;
    members: PolicyMember[];
    base: DiscoveredIdentity;
  } | null>(null);
  const [abhaModalOpen, setAbhaModalOpen] = useState(false);

  // Phase 4 smart-search state — separate from the single-mode state
  // so toggling between modes doesn't clobber the operator's inputs.
  const [smartMobile, setSmartMobile] = useState('');
  const [smartAbha, setSmartAbha] = useState('');
  const [smartAadhaar, setSmartAadhaar] = useState('');
  const [smartPolicy, setSmartPolicy] = useState('');
  const [smartResult, setSmartResult] = useState<IdentityDiscoverResponse | null>(null);

  // Look up the picked payer row so we can read its capability flag
  // (Phase 3 — supportsDiscoveryByMobile gates the NHCX mobile picker).
  const pickedPayer = payers.find((p) => p.code === payerCode) ?? null;
  const payerSupportsMobile = pickedPayer?.supportsDiscoveryByMobile ?? false;

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
      const base: DiscoveredIdentity = {
        identifierKind: kind,
        identifierValue: value,
        payerCode,
        ...(verify.planName !== null ? { productName: verify.planName } : {}),
        verifyResult: verify,
      };
      // Slice CO — floater/family policy: if the payer returned a
      // member roster, let the operator pick who's being treated
      // (same picker as PMJAY). Single-member policies return no
      // roster and finalise immediately, as before.
      if (verify.members && verify.members.length > 0) {
        setPendingMemberPick({
          title: verify.planName ?? 'Coverage',
          members: verify.members,
          base,
        });
      } else {
        onIdentityDiscovered(base);
      }
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

  // Phase 4 — smart search. Hits /identity/discover with every
  // identifier the operator supplied; the orchestrator runs each
  // across PMJAY + NHCX rails in best-to-worst order and returns the
  // union of matches + per-attempt diagnostic.
  const smartSearch = useCallback(async (): Promise<void> => {
    if (
      !smartMobile.trim() &&
      !smartAbha.trim() &&
      !smartAadhaar.trim() &&
      !smartPolicy.trim()
    ) {
      setValidationMsg('Enter at least one identifier to search.');
      return;
    }
    setValidationMsg(null);
    setLooking(true);
    try {
      const res = await IdentityDiscoverApi.discover({
        ...(smartMobile.trim() ? { mobile: smartMobile.trim() } : {}),
        ...(smartAbha.trim() ? { abhaId: smartAbha.trim() } : {}),
        ...(smartAadhaar.trim() ? { aadhaar: smartAadhaar.trim() } : {}),
        ...(smartPolicy.trim() ? { policyNumber: smartPolicy.trim() } : {}),
        ...(patientName.trim() ? { patientName } : {}),
        ...(hospitalMrn.trim() ? { hospitalMrn } : {}),
      });
      setSmartResult(res);
      showToast({
        tone: res.candidates.length > 0 ? 'success' : 'warning',
        message:
          res.candidates.length > 0
            ? `Found ${res.candidates.length} match${res.candidates.length === 1 ? '' : 'es'} across ${res.attempts.length} attempt${res.attempts.length === 1 ? '' : 's'}.`
            : `No matches across ${res.attempts.length} attempt${res.attempts.length === 1 ? '' : 's'}.`,
      });
    } catch (err) {
      showApiError(err);
    } finally {
      setLooking(false);
    }
  }, [
    hospitalMrn,
    patientName,
    showApiError,
    showToast,
    smartAadhaar,
    smartAbha,
    smartMobile,
    smartPolicy,
  ]);

  const onPickSmartCandidate = useCallback(
    (c: IdentityDiscoverCandidate) => {
      onIdentityDiscovered({
        identifierKind: c.identifierKind,
        identifierValue: c.identifierValue,
        payerCode: c.payerCode,
        ...(c.policyNumber !== null ? { policyNumber: c.policyNumber } : {}),
        ...(c.productName !== null ? { productName: c.productName } : {}),
      });
      setSmartResult(null);
      showToast({ tone: 'success', message: 'Candidate applied to the form.' });
    },
    [onIdentityDiscovered, showToast],
  );

  const onPickPmjayPolicy = useCallback(
    (policy: PmjayPolicy) => {
      const base: DiscoveredIdentity = {
        identifierKind: kind,
        identifierValue: value,
        payerCode: policy.payerId,
        policyNumber: policy.policyNumber,
        productName: policy.productName,
      };
      // Slice CO — if the policy carries a member roster (family/group),
      // pause and let the operator pick who's being treated. Otherwise
      // finalise immediately (single-beneficiary policy, no table).
      if (policy.members && policy.members.length > 0) {
        setPendingMemberPick({ title: policy.productName, members: policy.members, base });
        return;
      }
      onIdentityDiscovered(base);
      setPmjayResults(null);
    },
    [kind, onIdentityDiscovered, value],
  );

  // Slice CO — finalise once a member is chosen off any roster (PMJAY
  // policy or NHCX verify). The base identity is whatever the lookup
  // produced; we layer on the selected member's name + ABHA.
  const onPickMember = useCallback(
    (base: DiscoveredIdentity, member: PolicyMember) => {
      onIdentityDiscovered({
        ...base,
        patientName: member.name,
        ...(member.abhaNumber ? { abhaNumber: member.abhaNumber } : {}),
      });
      setPendingMemberPick(null);
      setPmjayResults(null);
    },
    [onIdentityDiscovered],
  );

  return (
    <div className="glass rounded-xl p-6">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">person_search</span>
          <h3 className="text-h3 font-h3 text-on-surface">Find patient</h3>
        </div>
        {/* Phase 4 mode toggle — Single vs Smart search. Smart hits
            /identity/discover with every identifier the operator
            supplies and returns the union of matches across rails. */}
        <div className="inline-flex rounded-lg border border-outline-variant/40 bg-surface-container-lowest p-1 text-body-sm">
          <button
            type="button"
            onClick={() => setMode('single')}
            className={`rounded-md px-3 py-1 transition ${mode === 'single' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:text-on-surface'}`}
          >
            Single
          </button>
          <button
            type="button"
            onClick={() => setMode('smart')}
            className={`rounded-md px-3 py-1 transition ${mode === 'smart' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:text-on-surface'}`}
          >
            Smart
          </button>
        </div>
      </div>
      <p className="mb-4 text-body-sm text-on-surface-variant">
        {mode === 'single'
          ? 'Pick the payer, then search by mobile, ABHA, Aadhaar, or policy number. The platform routes the lookup to the right gateway based on the rail.'
          : 'Fill in any identifiers you have. Smart search runs all of them across PMJAY + NHCX in parallel and shows every match.'}
      </p>

      {/* Payer dropdown — only rendered when the chosen identifier ×
          rail combination actually consumes payerCode. NHCX always
          needs it (verify-by-identifiers + discoverByMobile both
          require it). PMJAY only needs it for Aadhaar / policy in
          single mode (those fall through to verify-by-identifiers);
          PMJAY mobile + ABHA hit policies-lookup which returns its
          own payer. Smart mode fans out across every NHCX payer.
          Self-pay never needs it. */}
      {mode === 'single' && payerRequired(rail, kind) ? (
        <div className="mb-4">
          <label className={LABEL_CLS} htmlFor="identity-payer">Payer</label>
          <select
            id="identity-payer"
            value={payerCode ?? ''}
            onChange={(e) => onPayerChange(e.target.value)}
            className="glass-input"
            disabled={looking || payers.length === 0}
          >
            <option value="">Select a payer…</option>
            {payers.map((p) => (
              <option key={p.id} value={p.code}>
                {p.name} ({p.code})
                {p.supportsDiscoveryByMobile ? ' · mobile-discoverable' : ''}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {/* Smart-mode input grid — 4 identifier inputs, one Search button. */}
      {mode === 'smart' ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <SmartField id="smart-mobile" label="Mobile (10 digits)" value={smartMobile} setValue={setSmartMobile} maxLength={10} placeholder="9876543210" disabled={looking} />
            <SmartField id="smart-abha" label="ABHA (14 digits)" value={smartAbha} setValue={setSmartAbha} maxLength={14} placeholder="14004567891234" disabled={looking} />
            <SmartField id="smart-aadhaar" label="Aadhaar (12 digits)" value={smartAadhaar} setValue={setSmartAadhaar} maxLength={12} placeholder="123412341234" disabled={looking} />
            <SmartField id="smart-policy" label="Policy number" value={smartPolicy} setValue={setSmartPolicy} maxLength={64} placeholder="POL-XXXX-XXXX" disabled={looking} mono />
          </div>
          {validationMsg ? (
            <p className="text-body-sm text-error">{validationMsg}</p>
          ) : null}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void smartSearch()}
              disabled={looking}
              className="btn-cta"
            >
              {looking ? 'Searching all rails…' : 'Search everything'}
            </button>
          </div>
          {smartResult ? (
            <SmartResultsPanel result={smartResult} onPick={onPickSmartCandidate} />
          ) : null}
        </div>
      ) : null}

      {/* Single-mode identifier row (existing UI). */}
      {mode === 'single' ? (
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
      ) : null}

      {mode === 'single' && pendingMemberPick !== null ? (
        <MemberPickPanel
          title={pendingMemberPick.title}
          members={pendingMemberPick.members}
          onPick={(member) => onPickMember(pendingMemberPick.base, member)}
          onBack={() => setPendingMemberPick(null)}
        />
      ) : mode === 'single' && pmjayResults !== null ? (
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

      {abhaModalOpen ? (
        <AbhaCreator
          onCancel={() => setAbhaModalOpen(false)}
          onCompleted={(result: AbhaCreateVerifyResponse) => {
            setAbhaModalOpen(false);
            // Auto-promote the freshly-created ABHA into the search
            // flow: flip kind to ABHA, populate the value, and run
            // the lookup so the operator immediately sees any
            // matching PMJAY policies (or NHCX coverage).
            setKind('abha');
            setValue(result.abhaNumber);
            showToast({
              tone: 'success',
              message: `ABHA ${result.abhaNumber} created. Looking up policies now…`,
            });
            // Defer to next tick so the kind/value state is committed
            // before search() reads them.
            window.setTimeout(() => void search(), 0);
          }}
        />
      ) : null}
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
              {p.members && p.members.length > 0
                ? `Family policy · ${p.members.length} members`
                : `Member ${p.memberId}`}{' '}
              · Policy {p.policyNumber}
            </div>
            <div className="mt-2 inline-flex items-center gap-1 text-eyebrow uppercase tracking-eyebrow text-primary">
              {p.members && p.members.length > 0 ? 'Pick member →' : 'Pick policy →'}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// Slice CO — family/group member roster. Rendered only when a lookup
// (PMJAY policy) or verify (NHCX floater) returns members[]. The
// operator selects who's being treated; that member's name + ABHA
// flow into the case form. Rail-agnostic — driven by title + members.
function MemberPickPanel({
  title,
  members,
  onPick,
  onBack,
}: {
  title: string;
  members: PolicyMember[];
  onPick: (member: PolicyMember) => void;
  onBack: () => void;
}): JSX.Element {
  return (
    <div className="mt-5">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
          {title} · who is being treated?
        </span>
        <button
          type="button"
          onClick={onBack}
          className="text-body-sm text-primary hover:underline"
        >
          ← Back
        </button>
      </div>
      <div className="glass overflow-hidden rounded-lg">
        <table className="w-full text-left">
          <thead className="border-b border-outline-variant/40 bg-surface-container-lowest/50 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
            <tr>
              <th className="px-4 py-2">Member</th>
              <th className="px-4 py-2">Relationship</th>
              <th className="px-4 py-2">Age / Sex</th>
              <th className="px-4 py-2">ABHA</th>
              <th className="px-4 py-2 text-right">Select</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.memberId} className="border-b border-outline-variant/20">
                <td className="px-4 py-3 text-body text-on-surface">{m.name}</td>
                <td className="px-4 py-3 text-body-sm capitalize text-on-surface-variant">
                  {m.relationship ?? '—'}
                </td>
                <td className="px-4 py-3 text-body-sm tabular-nums text-on-surface-variant">
                  {m.age !== null ? `${m.age}` : '—'}
                  {m.gender ? ` · ${m.gender.charAt(0).toUpperCase()}` : ''}
                </td>
                <td className="px-4 py-3 font-mono text-body-sm text-on-surface-variant">
                  {m.abhaNumber ?? '—'}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => onPick(m)}
                    className="text-body-sm font-semibold text-primary hover:underline"
                  >
                    Treat this member →
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Phase 4 — single labelled input for the smart-search grid. Keeps
// the parent JSX compact.
function SmartField({
  id,
  label,
  value,
  setValue,
  maxLength,
  placeholder,
  disabled,
  mono,
}: {
  id: string;
  label: string;
  value: string;
  setValue: (v: string) => void;
  maxLength: number;
  placeholder: string;
  disabled: boolean;
  mono?: boolean;
}): JSX.Element {
  return (
    <div>
      <label className={LABEL_CLS} htmlFor={id}>{label}</label>
      <input
        id={id}
        value={value}
        onChange={(e) => setValue(e.target.value.replace(/\s+/g, ''))}
        maxLength={maxLength}
        placeholder={placeholder}
        disabled={disabled}
        className={`glass-input tabular-nums ${mono ? 'font-mono' : ''}`}
        autoComplete="off"
      />
    </div>
  );
}

// Phase 4 — smart-search results. Shows the union of matches + the
// per-attempt diagnostic + the suggested next step when no match
// surfaced. Each candidate row is clickable so the operator can
// promote it into the form via onPick.
function SmartResultsPanel({
  result,
  onPick,
}: {
  result: IdentityDiscoverResponse;
  onPick: (c: IdentityDiscoverCandidate) => void;
}): JSX.Element {
  return (
    <div className="space-y-4 border-t border-outline-variant/40 pt-4">
      {result.candidates.length > 0 ? (
        <div>
          <div className="mb-2 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
            {result.candidates.length === 1
              ? '1 candidate found'
              : `${result.candidates.length} candidates — pick one`}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {result.candidates.map((c, i) => (
              <button
                key={`${c.source}-${c.payerCode}-${i}`}
                type="button"
                onClick={() => onPick(c)}
                className="glass rounded-lg px-4 py-3 text-left transition hover:-translate-y-px"
              >
                <div className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
                  via {c.identifierKind} · {sourceLabel(c.source)}
                </div>
                <div className="mt-1 text-h3 font-semibold text-on-surface">
                  {c.productName ?? c.payerName ?? c.payerCode}
                </div>
                <div className="mt-1 text-body-sm text-on-surface-variant tabular-nums">
                  {c.policyNumber ? `Policy ${c.policyNumber}` : 'No policy ref'}
                  {c.memberId ? ` · Member ${c.memberId}` : ''}
                </div>
                <div className="mt-2 inline-flex items-center gap-1 text-eyebrow uppercase tracking-eyebrow text-primary">
                  Use this →
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-warning-500/30 bg-warning-50/60 px-4 py-3">
          <p className="text-body-sm text-on-surface">
            No matches across {result.attempts.length} attempt
            {result.attempts.length === 1 ? '' : 's'}.
            {result.suggestedNextStep === 'create_abha'
              ? ' Tip: generate an ABHA via the button below — that will likely surface a PMJAY enrolment.'
              : result.suggestedNextStep === 'contact_payer_helpline'
                ? " Tip: ask the patient to call the payer's helpline to confirm the identifier is still active."
                : result.suggestedNextStep === 'ask_for_policy_number'
                  ? ' Tip: ask the patient for their policy number — most NHCX payers index by it.'
                  : ''}
          </p>
        </div>
      )}

      <details className="text-body-sm text-on-surface-variant">
        <summary className="cursor-pointer hover:text-on-surface">
          Attempts ({result.attempts.length}) — what we tried
        </summary>
        <ul className="mt-2 space-y-1 pl-4">
          {result.attempts.map((a, i) => (
            <li key={i} className="font-mono text-xs">
              {a.identifierKind} → {sourceLabel(a.source)} ·{' '}
              <span
                className={
                  a.outcome === 'matched'
                    ? 'text-tertiary'
                    : a.outcome === 'error'
                      ? 'text-error'
                      : a.outcome === 'skipped'
                        ? 'text-on-surface-variant/60'
                        : 'text-on-surface-variant'
                }
              >
                {a.outcome}
              </span>
              {a.errorMessage ? ` · ${a.errorMessage}` : ''}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function sourceLabel(source: IdentityDiscoverCandidate['source']): string {
  if (source === 'pmjay_policies_lookup') return 'PMJAY';
  if (source === 'nhcx_verify_by_identifiers') return 'NHCX verify';
  return 'NHCX mobile';
}

// Mirrors the search()/routing matrix above. Used to gate the payer
// dropdown so the operator only sees it when the chosen identifier
// will actually consume payerCode downstream.
function payerRequired(rail: Rail, kind: IdentifierKind): boolean {
  if (rail === 'self_pay') return false;
  if (rail === 'nhcx') return true;
  return kind === 'aadhaar' || kind === 'policy';
}

