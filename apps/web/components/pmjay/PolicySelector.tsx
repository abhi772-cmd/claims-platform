'use client';

// PMJAY beneficiary policies lookup widget. Renders as a glass card
// with two states:
//
//   1. Input state  — operator picks ABHA or mobile, types the
//                     identifier, clicks "Find policies".
//   2. Result state — the API returns 0..N policies; operator
//                     picks one (or sees an empty-result message).
//
// Lifts the picked policy back to the parent via onPolicyPicked.
// PMJAY-only — only render this widget when rail === 'pmjay'.
//
// The /pmjay/policies/lookup endpoint is PMJAY-rail-gated server-side,
// so the operator can't pick a policy for a non-PMJAY tenant even if
// the widget is somehow rendered.

import {
  type PmjayPolicy,
  type PmjayPolicyLookupResponse,
} from '@claims/contracts';
import { useCallback, useState } from 'react';

import { PmjayPoliciesApi } from '../../lib/api/pmjay-policies.api';
import { useErrorModal } from '../modals/ErrorModal/ErrorModalProvider';

interface Props {
  // The caller controls the picked policy so it can drive downstream
  // form fields (policy number, payer ID, product name).
  pickedPolicy: PmjayPolicy | null;
  onPolicyPicked: (policy: PmjayPolicy) => void;
  // Lets the parent reset all the form fields that hang off the policy
  // (policy number, payer code, sum insured) when the operator clears.
  onCleared: () => void;
}

const ABHA_PATTERN = /^\d{14}$/;
const MOBILE_PATTERN = /^\d{10}$/;

const LABEL_CLS =
  'mb-1 block text-eyebrow uppercase tracking-eyebrow text-on-surface-variant';

export function PolicySelector({ pickedPolicy, onPolicyPicked, onCleared }: Props): JSX.Element {
  const { showApiError } = useErrorModal();
  const [identifierType, setIdentifierType] = useState<'abha' | 'mobile'>('abha');
  const [identifier, setIdentifier] = useState('');
  const [looking, setLooking] = useState(false);
  const [result, setResult] = useState<PmjayPolicyLookupResponse | null>(null);
  const [validationMsg, setValidationMsg] = useState<string | null>(null);

  const onChangeIdentifierType = useCallback((next: 'abha' | 'mobile') => {
    setIdentifierType(next);
    setIdentifier('');
    setValidationMsg(null);
  }, []);

  const localValidate = useCallback(
    (value: string): string | null => {
      if (!value) return 'Enter an identifier to look up.';
      if (identifierType === 'abha' && !ABHA_PATTERN.test(value)) {
        return 'ABHA must be 14 digits, no hyphens.';
      }
      if (identifierType === 'mobile' && !MOBILE_PATTERN.test(value)) {
        return 'Mobile must be 10 digits.';
      }
      return null;
    },
    [identifierType],
  );

  const lookup = useCallback(async (): Promise<void> => {
    const msg = localValidate(identifier);
    if (msg) {
      setValidationMsg(msg);
      return;
    }
    setValidationMsg(null);
    setLooking(true);
    try {
      const res = await PmjayPoliciesApi.lookup({ identifierType, identifier });
      setResult(res);
    } catch (err) {
      showApiError(err);
    } finally {
      setLooking(false);
    }
  }, [identifier, identifierType, localValidate, showApiError]);

  const clear = useCallback(() => {
    setResult(null);
    setIdentifier('');
    setValidationMsg(null);
    onCleared();
  }, [onCleared]);

  // Once a policy is picked, lock the input row and show a compact
  // summary so the operator can see what they chose and can clear it
  // if they got it wrong.
  if (pickedPolicy) {
    return (
      <div className="glass rounded-xl px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className={LABEL_CLS}>Selected PMJAY policy</div>
            <div className="text-h3 font-semibold text-on-surface">
              {pickedPolicy.productName}
            </div>
            <div className="mt-1 text-body-sm text-on-surface-variant tabular-nums">
              Member {pickedPolicy.memberId} · Policy {pickedPolicy.policyNumber}
            </div>
          </div>
          <button
            type="button"
            onClick={clear}
            className="btn-outline whitespace-nowrap"
          >
            Change
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="glass rounded-xl px-6 py-5">
      <div className={LABEL_CLS}>Beneficiary lookup</div>
      <h3 className="mb-1 text-h3 font-semibold text-on-surface">
        Find PMJAY beneficiary
      </h3>
      <p className="mb-4 text-body-sm text-on-surface-variant">
        Enter the beneficiary&apos;s ABHA or registered mobile to fetch the
        PMJAY policies they&apos;re enrolled in.
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[160px_1fr_auto]">
        <div>
          <label className={LABEL_CLS} htmlFor="pmjay-identifier-type">
            Identifier
          </label>
          <select
            id="pmjay-identifier-type"
            value={identifierType}
            onChange={(e) => onChangeIdentifierType(e.target.value as 'abha' | 'mobile')}
            className="glass-input"
            disabled={looking}
          >
            <option value="abha">ABHA</option>
            <option value="mobile">Mobile</option>
          </select>
        </div>
        <div>
          <label className={LABEL_CLS} htmlFor="pmjay-identifier">
            {identifierType === 'abha' ? '14-digit ABHA' : '10-digit mobile'}
          </label>
          <input
            id="pmjay-identifier"
            value={identifier}
            onChange={(e) => {
              setIdentifier(e.target.value.replace(/\s+/g, ''));
              setValidationMsg(null);
            }}
            inputMode="numeric"
            maxLength={identifierType === 'abha' ? 14 : 10}
            placeholder={identifierType === 'abha' ? '14004567891234' : '9876543210'}
            className="glass-input tabular-nums"
            disabled={looking}
            aria-invalid={validationMsg !== null}
            aria-describedby={validationMsg ? 'pmjay-identifier-error' : undefined}
          />
          {validationMsg ? (
            <p id="pmjay-identifier-error" className="mt-1 text-body-sm text-error">
              {validationMsg}
            </p>
          ) : null}
        </div>
        <div className="flex items-end">
          <button
            type="button"
            onClick={lookup}
            disabled={looking || identifier.length === 0}
            className="btn-cta whitespace-nowrap"
          >
            {looking ? 'Looking up…' : 'Find policies'}
          </button>
        </div>
      </div>

      {result ? (
        <PolicyResults
          result={result}
          onPick={(p) => {
            onPolicyPicked(p);
            setResult(null);
          }}
        />
      ) : null}
    </div>
  );
}

function PolicyResults({
  result,
  onPick,
}: {
  result: PmjayPolicyLookupResponse;
  onPick: (policy: PmjayPolicy) => void;
}): JSX.Element {
  if (result.policies.length === 0) {
    return (
      <div className="mt-5 rounded-lg border border-warning-500/30 bg-warning-50/60 px-4 py-3">
        <div className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
          No PMJAY policy found
        </div>
        <p className="mt-1 text-body-sm text-on-surface">
          We couldn&apos;t locate a PMJAY enrolment for the supplied{' '}
          {result.identifierType === 'abha' ? 'ABHA' : 'mobile number'}. Confirm
          the beneficiary is enrolled before proceeding — otherwise this case
          can&apos;t use the PMJAY rail.
        </p>
      </div>
    );
  }

  const multi = result.policies.length > 1;
  return (
    <div className="mt-5">
      <div className="mb-2 text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
        {multi
          ? `${result.policies.length} policies found — pick one`
          : '1 policy found'}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {result.policies.map((p) => (
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
              Member {p.memberId}
            </div>
            <div className="text-body-sm text-on-surface-variant tabular-nums">
              Policy {p.policyNumber}
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
