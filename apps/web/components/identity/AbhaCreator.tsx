'use client';

// Phase 2 — standalone modal for ABDM ABHA creation. Two-step flow:
//
//   stage='aadhaar'  operator enters 12-digit Aadhaar
//                    → POST /abha/init → ABDM sends OTP to the
//                    registered mobile → stage flips to 'otp'
//
//   stage='otp'      operator enters the 6-digit OTP they read back
//                    → POST /abha/verify → ABDM issues a fresh ABHA
//                    → stage flips to 'done', onCompleted fires
//
// Stub demo cheat-sheet (when API runs with ABHA_CREATION_MODE=stub):
//   * Use any 12-digit Aadhaar except those starting with 000000/999999
//   * OTP is 123456
//   * Aadhaar starting with 000000 → init rejects (no mobile linked)
//   * Aadhaar starting with 999999 → verify rejects (OTP mismatch)
//
// This component is used by IdentityDiscovery (Phase 1) — once the
// AbhaComingSoonModal is swapped for AbhaCreator the "Patient has no
// identifier?" path completes end-to-end.

import {
  type AbhaCreateInitResponse,
  type AbhaCreateVerifyResponse,
} from '@claims/contracts';
import { useCallback, useState } from 'react';

import { AbhaCreationApi } from '../../lib/api/abha-creation.api';
import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';
import { useToast } from '../toast/ToastProvider';

interface Props {
  onCompleted: (result: AbhaCreateVerifyResponse) => void;
  onCancel: () => void;
}

const AADHAAR_PATTERN = /^\d{12}$/;
const OTP_PATTERN = /^\d{6}$/;

const LABEL_CLS =
  'mb-1 block text-eyebrow uppercase tracking-eyebrow text-on-surface-variant';

export function AbhaCreator({ onCompleted, onCancel }: Props): JSX.Element {
  const { showApiError } = useErrorModal();
  const showToast = useToast();
  const [stage, setStage] = useState<'aadhaar' | 'otp' | 'done'>('aadhaar');
  const [aadhaar, setAadhaar] = useState('');
  const [otp, setOtp] = useState('');
  const [initResult, setInitResult] = useState<AbhaCreateInitResponse | null>(null);
  const [verifyResult, setVerifyResult] = useState<AbhaCreateVerifyResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const sendOtp = useCallback(async (): Promise<void> => {
    setErrMsg(null);
    if (!AADHAAR_PATTERN.test(aadhaar)) {
      setErrMsg('Aadhaar must be 12 digits.');
      return;
    }
    setBusy(true);
    try {
      const res = await AbhaCreationApi.init({ aadhaar });
      setInitResult(res);
      setStage('otp');
      showToast({
        tone: 'info',
        message: `OTP sent to ${res.mobileMasked}. Ask the patient to read it back.`,
      });
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : 'Failed to send OTP.');
      showApiError(err);
    } finally {
      setBusy(false);
    }
  }, [aadhaar, showApiError, showToast]);

  const verifyOtp = useCallback(async (): Promise<void> => {
    setErrMsg(null);
    if (!initResult) return;
    if (!OTP_PATTERN.test(otp)) {
      setErrMsg('OTP must be 6 digits.');
      return;
    }
    setBusy(true);
    try {
      const res = await AbhaCreationApi.verify({ txnId: initResult.txnId, otp });
      setVerifyResult(res);
      setStage('done');
      showToast({
        tone: 'success',
        message: `ABHA created: ${res.abhaNumber}. Auto-filled into the form.`,
      });
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : 'Failed to verify OTP.');
      showApiError(err);
    } finally {
      setBusy(false);
    }
  }, [initResult, otp, showApiError, showToast]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-modal flex items-center justify-center bg-on-surface/40 backdrop-blur-sm"
    >
      <div className="glass-strong w-[min(560px,calc(100%-32px))] rounded-xl p-6">
        <div className="mb-3 flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">id_card</span>
          <h3 className="text-h3 font-semibold text-on-surface">
            Generate ABHA via Aadhaar OTP
          </h3>
        </div>

        {stage === 'aadhaar' ? (
          <div className="space-y-4">
            <p className="text-body-sm text-on-surface-variant">
              Enter the patient&apos;s Aadhaar. ABDM will send a 6-digit OTP
              to the mobile number linked to it. The patient reads the OTP
              back to you on the next step.
            </p>
            <div>
              <label className={LABEL_CLS} htmlFor="abha-creator-aadhaar">
                12-digit Aadhaar
              </label>
              <input
                id="abha-creator-aadhaar"
                value={aadhaar}
                onChange={(e) => {
                  setAadhaar(e.target.value.replace(/\s+/g, ''));
                  setErrMsg(null);
                }}
                inputMode="numeric"
                maxLength={12}
                autoComplete="off"
                placeholder="123412341234"
                className="glass-input tabular-nums"
                disabled={busy}
                aria-invalid={errMsg !== null}
              />
              {errMsg ? (
                <p className="mt-1 text-body-sm text-error">{errMsg}</p>
              ) : null}
            </div>
            <p className="text-body-sm text-on-surface-variant">
              The Aadhaar is sent to ABDM over TLS and is never logged on our
              side. We only persist the resulting ABHA.
            </p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={onCancel}
                className="btn-outline"
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void sendOtp()}
                className="btn-cta"
                disabled={busy || aadhaar.length === 0}
              >
                {busy ? 'Sending OTP…' : 'Send OTP'}
              </button>
            </div>
          </div>
        ) : null}

        {stage === 'otp' && initResult ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-primary/20 bg-primary-fixed/30 px-4 py-3">
              <div className={LABEL_CLS}>OTP sent to</div>
              <div className="text-body text-on-surface tabular-nums">
                {initResult.mobileMasked}
              </div>
              {initResult.fullNameHint ? (
                <div className="mt-1 text-body-sm text-on-surface-variant">
                  Registered name: {initResult.fullNameHint}
                </div>
              ) : null}
            </div>
            <div>
              <label className={LABEL_CLS} htmlFor="abha-creator-otp">
                6-digit OTP
              </label>
              <input
                id="abha-creator-otp"
                value={otp}
                onChange={(e) => {
                  setOtp(e.target.value.replace(/\s+/g, ''));
                  setErrMsg(null);
                }}
                inputMode="numeric"
                maxLength={6}
                autoComplete="one-time-code"
                placeholder="123456"
                className="glass-input tabular-nums"
                disabled={busy}
                aria-invalid={errMsg !== null}
              />
              {errMsg ? (
                <p className="mt-1 text-body-sm text-error">{errMsg}</p>
              ) : null}
            </div>
            <div className="flex justify-between">
              <button
                type="button"
                onClick={() => {
                  setStage('aadhaar');
                  setOtp('');
                  setInitResult(null);
                  setErrMsg(null);
                }}
                className="btn-outline"
                disabled={busy}
              >
                ← Back
              </button>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={onCancel}
                  className="btn-outline"
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void verifyOtp()}
                  className="btn-cta"
                  disabled={busy || otp.length === 0}
                >
                  {busy ? 'Verifying…' : 'Verify & create ABHA'}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {stage === 'done' && verifyResult ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-tertiary/30 bg-tertiary-container px-4 py-3">
              <div className={LABEL_CLS}>ABHA created</div>
              <div className="text-h3 font-semibold tabular-nums text-on-surface">
                {verifyResult.abhaNumber}
              </div>
              {verifyResult.healthIdNumber ? (
                <div className="mt-1 text-body-sm text-on-surface-variant">
                  Health ID: {verifyResult.healthIdNumber}
                </div>
              ) : null}
              {verifyResult.fullName ? (
                <div className="mt-1 text-body-sm text-on-surface-variant">
                  Name: {verifyResult.fullName}
                  {verifyResult.gender ? ` · ${verifyResult.gender}` : ''}
                  {verifyResult.dateOfBirth ? ` · DOB ${verifyResult.dateOfBirth}` : ''}
                </div>
              ) : null}
            </div>
            <p className="text-body-sm text-on-surface-variant">
              The ABHA will auto-fill into the patient form, and we&apos;ll
              immediately re-run the policy lookup to find any PMJAY
              enrolment linked to it.
            </p>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => onCompleted(verifyResult)}
                className="btn-cta"
              >
                Use this ABHA
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
