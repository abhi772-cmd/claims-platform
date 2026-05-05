'use client';

import { type PasswordPolicyDescriptor } from '@claims/contracts';

export interface PasswordCheck {
  label: string;
  ok: boolean;
}

export function evaluatePassword(
  password: string,
  policy: PasswordPolicyDescriptor,
  context: { email: string; firstName?: string; lastName?: string },
): { score: 0 | 1 | 2 | 3 | 4; checks: PasswordCheck[] } {
  const checks: PasswordCheck[] = [
    { label: `At least ${policy.minLength} characters`, ok: password.length >= policy.minLength },
    { label: 'Contains a lowercase letter', ok: !policy.requireLower || /[a-z]/.test(password) },
    { label: 'Contains an uppercase letter', ok: !policy.requireUpper || /[A-Z]/.test(password) },
    { label: 'Contains a digit', ok: !policy.requireDigit || /[0-9]/.test(password) },
    { label: 'Contains a symbol', ok: !policy.requireSymbol || /[^A-Za-z0-9]/.test(password) },
  ];

  const lower = password.toLowerCase();
  const localPart = context.email.split('@')[0]?.toLowerCase() ?? '';
  const personal = [localPart, context.firstName, context.lastName]
    .map((t) => (t ?? '').trim().toLowerCase())
    .filter((t) => t.length >= 4);
  const usesPersonal = personal.some((token) => token && lower.includes(token));
  checks.push({ label: "Doesn't include your name or email", ok: password.length > 0 && !usesPersonal });

  const passed = checks.filter((c) => c.ok).length;
  // 0/1/2 fails ⇒ score 0..2; all 6 pass + length ≥ 16 ⇒ 4; otherwise 3.
  let score: 0 | 1 | 2 | 3 | 4 = 0;
  if (passed === checks.length) {
    score = password.length >= 16 ? 4 : 3;
  } else if (passed >= checks.length - 1) {
    score = 2;
  } else if (passed >= checks.length - 2) {
    score = 1;
  }
  return { score, checks };
}

const SCORE_LABEL: Record<number, string> = {
  0: 'Too weak',
  1: 'Weak',
  2: 'OK',
  3: 'Strong',
  4: 'Excellent',
};

const SCORE_COLOR: Record<number, string> = {
  0: 'bg-error-500',
  1: 'bg-warning-500',
  2: 'bg-warning-300',
  3: 'bg-success-500',
  4: 'bg-success-600',
};

export function PasswordStrengthMeter({
  password,
  policy,
  context,
}: {
  password: string;
  policy: PasswordPolicyDescriptor | null;
  context: { email: string; firstName?: string; lastName?: string };
}): JSX.Element | null {
  if (!policy || password.length === 0) return null;
  const { score, checks } = evaluatePassword(password, policy, context);
  return (
    <div className="space-y-2">
      <div className="flex gap-1" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-sm ${i <= score ? SCORE_COLOR[score] : 'bg-neutral-200'}`}
          />
        ))}
      </div>
      <p className="text-xs text-neutral-600">Strength: {SCORE_LABEL[score]}</p>
      <ul className="space-y-1 text-xs">
        {checks.map((c) => (
          <li key={c.label} className={c.ok ? 'text-success-700' : 'text-neutral-500'}>
            {c.ok ? '✓' : '○'} {c.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
