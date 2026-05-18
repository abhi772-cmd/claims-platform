'use client';

// BIS biometric capture — case-scoped two-step ABHA biometric (init →
// device-capture → verify). PMJAY mandates this at admission alongside
// ABHA/Aadhaar identification.
//
// Three modes:
//   * Real (BIOMETRIC_AUTH_MODE=http): full flow — init returns txnId,
//     a registered fingerprint/iris device SDK captures the PID, we
//     post the PID to /verify, get verificationId.
//   * Stub (BIOMETRIC_AUTH_MODE=stub): same wire shape, fake PID.
//     Used in dev + demos.
//   * Disabled (BIOMETRIC_AUTH_MODE=disabled): both endpoints return
//     { status: 'disabled' }. The UI degrades to the OTP fallback.
//
// The device-capture step is intentionally abstracted — in production
// the hospital's biometric SDK pushes PID into a callback we don't
// own. For the UI we expose a "Simulate capture" button in non-prod
// modes so the operator can advance the flow.
//
// OTP fallback: ABDM's OTP-based ABHA verification is a separate flow
// not yet wired in our API; for now the UI surfaces the option but
// records the decision as a manual override (so audit captures the
// operator's choice to skip biometric).

import {
  type BiometricAuthMode,
  type BiometricInitRequest,
  type BiometricLoginHint,
} from '@claims/contracts';
import { useCallback, useState } from 'react';

import { BiometricAuthApi } from '../../lib/api/biometric-auth.api';
import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';
import { useToast } from '../toast/ToastProvider';

export interface BiometricResult {
  verificationId: string | null;
  verifiedAt: string | null;
  // 'biometric' = full BIS flow succeeded
  // 'otp_fallback' = operator chose OTP path (audit will mark this)
  // 'disabled' = backend reports BIS adapter is disabled
  method: 'biometric' | 'otp_fallback' | 'disabled';
}

interface Props {
  // The case must already exist — biometric endpoints are case-scoped.
  // For the new-case flow this means we capture the biometric AFTER
  // the case is created (between admission and preauth). For the
  // pre-case discovery flow we use ABHA/mobile policy lookup only.
  caseId: string;
  // ABHA / mobile / Aadhaar — used as loginId. Server hashes it before
  // persisting, but UI must keep it out of logs.
  loginId: string;
  loginHint: BiometricLoginHint;
  // PMJAY payer participant code from the picked policy.
  payerId: string;
  // Outer ABHA-platform JWT — supplied upstream by an ABDM consent flow
  // the API doesn't own. Pass through as opaque string.
  bearerToken: string;
  process: 'Preauth' | 'Discharge';
  onCompleted: (result: BiometricResult) => void;
}

const SCOPE_BY_MODE: Record<
  BiometricAuthMode,
  BiometricInitRequest['scope']
> = {
  FINGERPRINT: 'aadhaar-bio-verify',
  IRIS: 'aadhaar-iris-verify',
  FACE_AUTH: 'aadhaar-face-verify',
};

const STUB_PID = 'stub-pid-eyJ0eXAiOiJKV1QifQ.placeholder';

const LABEL_CLS =
  'mb-1 block text-eyebrow uppercase tracking-eyebrow text-on-surface-variant';

export function BiometricCapture({
  caseId,
  loginId,
  loginHint,
  payerId,
  bearerToken,
  process,
  onCompleted,
}: Props): JSX.Element {
  const { showApiError } = useErrorModal();
  const showToast = useToast();
  const [authMode, setAuthMode] = useState<BiometricAuthMode>('FINGERPRINT');
  const [txnId, setTxnId] = useState<string | null>(null);
  const [stage, setStage] = useState<'idle' | 'init' | 'capture' | 'verify' | 'done' | 'disabled'>(
    'idle',
  );
  const [otpDialogOpen, setOtpDialogOpen] = useState(false);

  const start = useCallback(async (): Promise<void> => {
    setStage('init');
    try {
      const res = await BiometricAuthApi.init(caseId, {
        scope: SCOPE_BY_MODE[authMode],
        loginHint,
        loginId,
        authMode,
        process,
        payerId,
        bearerToken,
      });
      if (res.status === 'disabled') {
        setStage('disabled');
        showToast({
          tone: 'warning',
          message:
            'Biometric adapter is disabled on this environment. Use the OTP fallback.',
        });
        return;
      }
      if (!res.txnId) {
        showApiError(new Error('Biometric init response missing txnId.'));
        setStage('idle');
        return;
      }
      setTxnId(res.txnId);
      setStage('capture');
    } catch (err) {
      showApiError(err);
      setStage('idle');
    }
  }, [authMode, bearerToken, caseId, loginHint, loginId, payerId, process, showApiError, showToast]);

  const completeWithPid = useCallback(
    async (pid: string): Promise<void> => {
      if (!txnId) return;
      setStage('verify');
      try {
        const res = await BiometricAuthApi.verify(caseId, {
          scope: SCOPE_BY_MODE[authMode],
          authMode,
          loginHint,
          loginId,
          authData: {
            txnId,
            ...(authMode === 'FINGERPRINT' ? { fingerPrintAuthPid: pid } : {}),
            ...(authMode === 'IRIS' ? { irisAuthPid: pid } : {}),
            ...(authMode === 'FACE_AUTH' ? { faceAuthPid: pid } : {}),
          },
          process,
          payerId,
          bearerToken,
        });
        if (res.status === 'disabled') {
          setStage('disabled');
          return;
        }
        setStage('done');
        onCompleted({
          verificationId: res.verificationId ?? null,
          verifiedAt: res.verifiedAt ?? null,
          method: 'biometric',
        });
        showToast({ tone: 'success', message: 'Biometric verified.' });
      } catch (err) {
        showApiError(err);
        setStage('capture');
      }
    },
    [authMode, bearerToken, caseId, loginHint, loginId, onCompleted, payerId, process, showApiError, showToast, txnId],
  );

  const onOtpFallbackConfirm = useCallback(() => {
    setOtpDialogOpen(false);
    onCompleted({ verificationId: null, verifiedAt: null, method: 'otp_fallback' });
    showToast({
      tone: 'info',
      message: 'Recorded OTP fallback. Biometric step bypassed.',
    });
  }, [onCompleted, showToast]);

  if (stage === 'done') {
    return (
      <div className="glass rounded-xl px-6 py-5">
        <div className={LABEL_CLS}>Biometric — verified</div>
        <p className="text-body text-on-surface">
          ABHA biometric capture completed successfully. The case is cleared
          to proceed.
        </p>
      </div>
    );
  }

  if (stage === 'disabled') {
    return (
      <div className="glass rounded-xl px-6 py-5">
        <div className={LABEL_CLS}>Biometric — adapter disabled</div>
        <p className="mb-3 text-body text-on-surface">
          The BIS biometric adapter is disabled on this environment. Use the
          OTP fallback to record beneficiary verification.
        </p>
        <button
          type="button"
          onClick={() => setOtpDialogOpen(true)}
          className="btn-cta"
        >
          Use OTP fallback
        </button>
        {otpDialogOpen ? (
          <OtpFallbackDialog
            onCancel={() => setOtpDialogOpen(false)}
            onConfirm={onOtpFallbackConfirm}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="glass rounded-xl px-6 py-5">
      <div className={LABEL_CLS}>Beneficiary BIS verification</div>
      <h3 className="mb-1 text-h3 font-semibold text-on-surface">
        Capture ABHA biometric
      </h3>
      <p className="mb-4 text-body-sm text-on-surface-variant">
        Place the beneficiary&apos;s finger on the scanner, or switch to iris
        / face authentication. PMJAY mandates this at admission alongside
        ABHA/Aadhaar.
      </p>

      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-[200px_1fr]">
        <div>
          <label className={LABEL_CLS} htmlFor="biometric-mode">
            Mode
          </label>
          <select
            id="biometric-mode"
            value={authMode}
            onChange={(e) => setAuthMode(e.target.value as BiometricAuthMode)}
            className="glass-input"
            disabled={stage !== 'idle'}
          >
            <option value="FINGERPRINT">Fingerprint</option>
            <option value="IRIS">Iris</option>
            <option value="FACE_AUTH">Face</option>
          </select>
        </div>
        <div>
          <div className={LABEL_CLS}>Beneficiary</div>
          <div className="text-body text-on-surface">
            {loginHint === 'abha-number' ? 'ABHA' : loginHint === 'mobile' ? 'Mobile' : 'Aadhaar'}
            {' · '}
            <span className="tabular-nums">{maskLoginId(loginId)}</span>
          </div>
        </div>
      </div>

      {stage === 'idle' ? (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={start} className="btn-cta">
            Start biometric capture
          </button>
          <button
            type="button"
            onClick={() => setOtpDialogOpen(true)}
            className="btn-outline"
          >
            Use OTP instead
          </button>
        </div>
      ) : null}

      {stage === 'init' ? (
        <div className="text-body text-on-surface-variant">
          Initialising secure channel with ABHA…
        </div>
      ) : null}

      {stage === 'capture' ? (
        <div className="rounded-lg border border-outline-variant/60 bg-surface-container-lowest px-4 py-4">
          <div className="text-body text-on-surface">
            Place the beneficiary&apos;s{' '}
            {authMode === 'FINGERPRINT'
              ? 'finger on the scanner'
              : authMode === 'IRIS'
                ? 'eye to the iris reader'
                : 'face in the camera frame'}
            …
          </div>
          <div className="mt-2 text-body-sm text-on-surface-variant">
            Waiting for the device SDK to push a signed PID. In dev / stub
            environments use the Simulate button below.
          </div>
          <div className="mt-3 flex gap-3">
            <button
              type="button"
              onClick={() => completeWithPid(STUB_PID)}
              className="btn-primary"
            >
              Simulate capture (dev)
            </button>
            <button
              type="button"
              onClick={() => setStage('idle')}
              className="btn-outline"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {stage === 'verify' ? (
        <div className="text-body text-on-surface-variant">Verifying with ABHA…</div>
      ) : null}

      {otpDialogOpen ? (
        <OtpFallbackDialog
          onCancel={() => setOtpDialogOpen(false)}
          onConfirm={onOtpFallbackConfirm}
        />
      ) : null}
    </div>
  );
}

function OtpFallbackDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-on-surface/40 backdrop-blur-sm">
      <div className="glass-strong w-[min(480px,calc(100%-32px))] rounded-xl p-6">
        <h4 className="mb-1 text-h3 font-semibold text-on-surface">
          Bypass biometric with OTP?
        </h4>
        <p className="mb-4 text-body-sm text-on-surface-variant">
          The hospital staff has confirmed the beneficiary&apos;s identity via
          an Aadhaar/ABHA OTP sent to the registered mobile. This is recorded
          in the audit log as a fallback and may be reviewed by the payer.
        </p>
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onCancel} className="btn-outline">
            Cancel
          </button>
          <button type="button" onClick={onConfirm} className="btn-cta">
            Confirm OTP verification
          </button>
        </div>
      </div>
    </div>
  );
}

// Mask everything but the last 4 digits of the loginId so the UI never
// renders a full ABHA / mobile / Aadhaar. The server already hashes the
// canonical value; this is defence-in-depth for the operator screen.
function maskLoginId(value: string): string {
  if (value.length <= 4) return value;
  return `${'•'.repeat(value.length - 4)}${value.slice(-4)}`;
}
