'use client';

// PMJAY-only gating wrapper for BiometricCapture. Rendered at the top
// of the case detail page for PMJAY cases that haven't yet captured a
// biometric (or chosen the OTP fallback). Once the operator records a
// verification this component dismisses itself for the session — the
// canonical record lives server-side; this client state just prevents
// the gate from re-rendering on the same case visit.
//
// We don't have an "is-this-case-biometric-verified" GET endpoint yet,
// so this is session-local. When that endpoint lands, the wrapper
// reads it on mount and skips the gate entirely if already verified.

import {
  type BiometricLoginHint,
} from '@claims/contracts';
import { useState } from 'react';

import { BiometricCapture, type BiometricResult } from './BiometricCapture';

interface Props {
  caseId: string;
  // Rail comes from CaseDetail.primaryRail. The gate self-hides for
  // non-PMJAY cases.
  rail: 'nhcx' | 'pmjay' | 'self_pay';
}

const LABEL_CLS =
  'mb-1 block text-eyebrow uppercase tracking-eyebrow text-on-surface-variant';

export function BiometricGateCard({ caseId, rail }: Props): JSX.Element | null {
  const [loginId, setLoginId] = useState('');
  const [loginHint, setLoginHint] = useState<BiometricLoginHint>('abha-number');
  const [bearerToken, setBearerToken] = useState('');
  // PMJAY payer NHCX participant code (e.g. 'pmjay@hcx'). The
  // canonical value lives on the claim's payer master row, but the
  // claim API doesn't surface payerCode yet; until it does the
  // operator types it here.
  const [payerId, setPayerId] = useState('');
  const [captureOpen, setCaptureOpen] = useState(false);
  const [completed, setCompleted] = useState<BiometricResult | null>(null);

  if (rail !== 'pmjay') return null;
  if (completed) {
    return (
      <section className="glass space-y-2 rounded-xl p-6">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">verified</span>
          <h3 className="text-h3 font-h3 text-on-surface">Beneficiary verification</h3>
        </div>
        <p className="text-body text-on-surface-variant">
          {completed.method === 'biometric'
            ? `BIS biometric verified${completed.verifiedAt ? ` at ${new Date(completed.verifiedAt).toLocaleString('en-IN')}` : ''}.`
            : completed.method === 'otp_fallback'
              ? 'Operator recorded OTP fallback. Biometric step bypassed and noted in audit.'
              : 'BIS adapter disabled on this environment — no biometric was captured.'}
        </p>
      </section>
    );
  }

  if (!captureOpen) {
    return (
      <section className="glass space-y-4 rounded-xl p-6">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">fingerprint</span>
          <h3 className="text-h3 font-h3 text-on-surface">Beneficiary BIS verification</h3>
        </div>
        <p className="text-body-sm text-on-surface-variant">
          PMJAY requires ABHA biometric authentication at admission. Supply the
          beneficiary identifier and the ABDM consent token issued upstream,
          then open the capture flow.
        </p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[200px_1fr]">
          <div>
            <label className={LABEL_CLS} htmlFor="biometric-login-hint">
              Identifier kind
            </label>
            <select
              id="biometric-login-hint"
              value={loginHint}
              onChange={(e) => setLoginHint(e.target.value as BiometricLoginHint)}
              className="glass-input"
            >
              <option value="abha-number">ABHA</option>
              <option value="mobile">Mobile</option>
              <option value="aadhaar">Aadhaar</option>
            </select>
          </div>
          <div>
            <label className={LABEL_CLS} htmlFor="biometric-login-id">
              {loginHint === 'abha-number'
                ? '14-digit ABHA'
                : loginHint === 'mobile'
                  ? '10-digit mobile'
                  : '12-digit Aadhaar'}
            </label>
            <input
              id="biometric-login-id"
              value={loginId}
              onChange={(e) => setLoginId(e.target.value.replace(/\s+/g, ''))}
              inputMode="numeric"
              maxLength={14}
              className="glass-input tabular-nums"
              placeholder="Capture the printed/spoken identifier"
            />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[280px_1fr]">
          <div>
            <label className={LABEL_CLS} htmlFor="biometric-payer">
              Payer participant code
            </label>
            <input
              id="biometric-payer"
              value={payerId}
              onChange={(e) => setPayerId(e.target.value.trim())}
              className="glass-input"
              placeholder="pmjay@hcx"
              autoComplete="off"
            />
            <p className="mt-1 text-body-sm text-on-surface-variant">
              The PMJAY SHA&apos;s NHCX participant code.
            </p>
          </div>
          <div>
            <label className={LABEL_CLS} htmlFor="biometric-bearer">
              ABDM consent token
            </label>
            <input
              id="biometric-bearer"
              value={bearerToken}
              onChange={(e) => setBearerToken(e.target.value)}
              className="glass-input"
              placeholder="JWT issued by the ABDM consent flow"
              autoComplete="off"
            />
            <p className="mt-1 text-body-sm text-on-surface-variant">
              Plumbed in from a separate ABDM consent flow upstream — the
              biometric service does not mint this.
            </p>
          </div>
        </div>
        <div>
          <button
            type="button"
            onClick={() => setCaptureOpen(true)}
            disabled={!loginId || !bearerToken || !payerId}
            className="btn-cta"
          >
            Open capture flow
          </button>
        </div>
      </section>
    );
  }

  return (
    <BiometricCapture
      caseId={caseId}
      loginId={loginId}
      loginHint={loginHint}
      payerId={payerId}
      bearerToken={bearerToken}
      process="Preauth"
      onCompleted={(result) => {
        setCompleted(result);
        setCaptureOpen(false);
      }}
    />
  );
}
