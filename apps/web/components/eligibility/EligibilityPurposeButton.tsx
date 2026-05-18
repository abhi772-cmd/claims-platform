'use client';

// Single-purpose eligibility trigger. Used inside the operator panels
// at the moments PMJAY requires a fresh eligibility cycle:
//
//   purpose=validation         after registration (case detail header)
//   purpose=benefits           before preauth (inside PreauthPanel)
//   purpose=auth-requirements  before claim submit (inside ClaimPhasePanel)
//
// Private rails (non-PMJAY) use the legacy implicit purpose — we
// surface the button anyway so private-rail operators can re-poll
// eligibility from the same UI affordance, but we omit the purpose
// field on the wire.

import {
  type EligibilityPurpose,
  type EligibilityResponse,
} from '@claims/contracts';
import { useCallback, useState } from 'react';

import { EligibilityApi } from '../../lib/api/eligibility.api';
import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';
import { useToast } from '../toast/ToastProvider';

interface Props {
  caseId: string;
  claimId: string;
  // Determines whether `purpose` gets sent on the wire.
  rail: 'nhcx' | 'pmjay' | 'self_pay';
  purpose: EligibilityPurpose;
  // Plain-English label for the operator. The button labels itself
  // based on purpose if this is omitted.
  label?: string;
  // Plain-English explanation rendered next to the button.
  helpText?: string;
  // Notify parent so it can refresh the claim header / chip / etc.
  onCompleted?: (result: EligibilityResponse) => void;
}

const DEFAULT_LABEL: Record<EligibilityPurpose, string> = {
  validation: 'Validate beneficiary',
  benefits: 'Refresh benefits',
  'auth-requirements': 'Fetch document checklist',
};

const DEFAULT_HELP: Record<EligibilityPurpose, string> = {
  validation:
    'Confirm the beneficiary is still active on this scheme and check wallet balance.',
  benefits:
    'Fetch the current coverage limits and co-pay before drafting the preauth.',
  'auth-requirements':
    'Pull the payer-specific document checklist before submitting the claim.',
};

export function EligibilityPurposeButton({
  caseId,
  claimId,
  rail,
  purpose,
  label,
  helpText,
  onCompleted,
}: Props): JSX.Element {
  const { showApiError } = useErrorModal();
  const showToast = useToast();
  const [running, setRunning] = useState(false);

  const run = useCallback(async (): Promise<void> => {
    setRunning(true);
    try {
      // Only attach the purpose field for PMJAY tenants — private
      // rails treat it as implicit and the service rejects unknown
      // purposes for non-PMJAY callers.
      const out =
        rail === 'pmjay'
          ? await EligibilityApi.runForClaim(caseId, claimId, { purpose })
          : await EligibilityApi.runForClaim(caseId, claimId, {});
      showToast({
        tone: out.verified ? 'success' : 'warning',
        message: out.verified
          ? `Eligibility cycle (${purpose}) succeeded.`
          : `Eligibility (${purpose}) returned not verified: ${out.failureReason ?? 'see integration messages.'}`,
      });
      onCompleted?.(out);
    } catch (err) {
      showApiError(err);
    } finally {
      setRunning(false);
    }
  }, [caseId, claimId, onCompleted, purpose, rail, showApiError, showToast]);

  const buttonLabel = label ?? DEFAULT_LABEL[purpose];
  const help = helpText ?? DEFAULT_HELP[purpose];

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={run}
        disabled={running}
        className="btn-outline whitespace-nowrap"
      >
        <span
          className="material-symbols-outlined"
          style={{ fontSize: 18, fontVariationSettings: "'FILL' 1" }}
        >
          fact_check
        </span>
        {running ? 'Running…' : buttonLabel}
      </button>
      <span className="text-body-sm text-on-surface-variant">{help}</span>
    </div>
  );
}
