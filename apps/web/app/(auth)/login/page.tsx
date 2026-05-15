'use client';

import { LoginRequestSchema } from '@claims/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react';

import { useErrorModal } from '../../../components/modals/ErrorModal/ErrorModalProvider';
import { AuthApi } from '../../../lib/api/auth.api';

// "Split Premium" handoff — second iteration
// (login-2/project/login-variants.jsx + login-form.jsx).
// Deltas from the first iteration:
//   - SSO button + OR divider removed
//   - Character CAPTCHA inserted above the Sign-in button; submit
//     stays muted until the typed value matches the displayed code
//   - HIPAA footer centered + "· ISO 27001" dropped
// Credentials still wire through LoginRequestSchema + AuthApi.login,
// with the existing MFA-challenge redirect preserved.

const TEAL = '#008F99';
const TEAL_DEEP = '#0B2A2C';
const TEAL_FOCUS_SHADOW = 'rgba(0,143,153,0.13)';
const MUTED = '#6B8589';
const LABEL = '#3A5256';
const AMBER = '#FAA719';
const AMBER_HOVER = '#E89510';
const GREEN_CHECK = '#4FA88A';

export default function LoginPage(): JSX.Element {
  const router = useRouter();
  const { showApiError, showError } = useErrorModal();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [remember, setRemember] = useState(true);
  const [captchaVerified, setCaptchaVerified] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [focused, setFocused] = useState<'email' | 'password' | null>(null);

  const emailLooksValid =
    email.includes('@') && email.indexOf('.') > email.indexOf('@');

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!captchaVerified) {
      showError('VALIDATION_FAILED', 'Complete the security check first.');
      return;
    }
    const parsed = LoginRequestSchema.safeParse({ email, password });
    if (!parsed.success) {
      showError('VALIDATION_FAILED', parsed.error.issues[0]?.message);
      return;
    }
    setSubmitting(true);
    try {
      const result = await AuthApi.login(parsed.data);
      if ('mfaRequired' in result && result.mfaRequired) {
        const params = new URLSearchParams({
          challenge: result.challengeId,
          expires: result.expiresAt,
        });
        router.push(`/mfa-challenge?${params.toString()}`);
        return;
      }
      router.push('/dashboard');
    } catch (err) {
      showApiError(err);
    } finally {
      setSubmitting(false);
    }
    void remember;
  }

  function fieldStyle(key: 'email' | 'password'): CSSProperties {
    const isFocused = focused === key;
    return {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      background: 'rgba(255,255,255,0.65)',
      border: `1.5px solid ${isFocused ? TEAL : 'rgba(11,42,44,0.08)'}`,
      borderRadius: 12,
      padding: '0 14px',
      height: 52,
      transition:
        'border-color 220ms ease, box-shadow 220ms ease, background 220ms ease',
      boxShadow: isFocused
        ? `0 0 0 4px ${TEAL_FOCUS_SHADOW}, inset 0 1px 0 rgba(255,255,255,0.6)`
        : 'inset 0 1px 0 rgba(255,255,255,0.5)',
      backdropFilter: 'blur(8px)',
      WebkitBackdropFilter: 'blur(8px)',
    };
  }

  const inputBase: CSSProperties = {
    flex: 1,
    background: 'transparent',
    border: 'none',
    outline: 'none',
    fontFamily: "'Sora', system-ui, sans-serif",
    fontSize: 15,
    color: TEAL_DEEP,
    letterSpacing: '0.01em',
  };

  // Sign-in is muted (60% gradient + not-allowed cursor) until the
  // captcha matches. Submitting also hard-blocks the submit handler.
  const submitDisabled = submitting || !captchaVerified;

  return (
    <div
      className="font-auth relative w-full"
      style={{
        padding: '44px 44px 36px',
        borderRadius: 28,
        background: 'rgba(255,255,255,0.72)',
        backdropFilter: 'blur(28px) saturate(160%)',
        WebkitBackdropFilter: 'blur(28px) saturate(160%)',
        border: '1px solid rgba(255,255,255,0.9)',
        boxShadow:
          '0 40px 80px -24px rgba(0,80,86,0.32), 0 8px 24px -8px rgba(0,80,86,0.15), inset 0 1px 0 rgba(255,255,255,0.9)',
      }}
    >
      <div className="mb-7">
        <h2
          className="m-0 text-[28px] font-semibold"
          style={{ color: TEAL_DEEP, letterSpacing: '-0.015em' }}
        >
          Welcome back
        </h2>
        <p
          className="mt-[6px] text-[14.5px] font-normal"
          style={{ color: MUTED }}
        >
          Sign in to manage your hospital&apos;s claims.
        </p>
      </div>

      <form onSubmit={onSubmit} className="flex w-full flex-col gap-[18px]" noValidate>
        {/* Email */}
        <div>
          <div
            className="mb-2 text-[12px] font-medium uppercase"
            style={{ color: LABEL, letterSpacing: '0.04em' }}
          >
            Email address
          </div>
          <div style={fieldStyle('email')}>
            <span className="flex" style={{ color: TEAL }}>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <path d="m3 7 9 6 9-6" />
              </svg>
            </span>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onFocus={() => setFocused('email')}
              onBlur={() => setFocused(null)}
              style={inputBase}
            />
            {emailLooksValid && (
              <span className="flex" style={{ color: GREEN_CHECK }}>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 12l5 5L20 6" />
                </svg>
              </span>
            )}
          </div>
        </div>

        {/* Password */}
        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <span
              className="text-[12px] font-medium uppercase"
              style={{ color: LABEL, letterSpacing: '0.04em' }}
            >
              Password
            </span>
            <Link
              href="/forgot-password"
              className="text-[12.5px] font-medium no-underline"
              style={{ color: TEAL }}
            >
              Forgot password?
            </Link>
          </div>
          <div style={fieldStyle('password')}>
            <span className="flex" style={{ color: TEAL }}>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="11" width="16" height="10" rx="2" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>
            </span>
            <input
              id="password"
              name="password"
              type={showPw ? 'text' : 'password'}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onFocus={() => setFocused('password')}
              onBlur={() => setFocused(null)}
              style={inputBase}
            />
            <button
              type="button"
              onClick={() => setShowPw((s) => !s)}
              aria-label={showPw ? 'Hide password' : 'Show password'}
              className="flex cursor-pointer border-0 bg-transparent p-1"
              style={{ color: MUTED }}
            >
              {showPw ? (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a13.16 13.16 0 0 1-2.4 3.2" />
                  <path d="M6.6 6.6A13.5 13.5 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 4-1" />
                  <path d="m2 2 20 20" />
                  <path d="M9.5 9.5a3 3 0 0 0 4.2 4.2" />
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* Keep me signed in */}
        <label className="-mt-[2px] flex cursor-pointer items-center gap-[10px]">
          <span
            onClick={(e) => {
              e.preventDefault();
              setRemember((r) => !r);
            }}
            className="flex items-center justify-center transition-all"
            style={{
              width: 18,
              height: 18,
              borderRadius: 5,
              border: `1.5px solid ${remember ? TEAL : 'rgba(11,42,44,0.2)'}`,
              background: remember ? TEAL : 'transparent',
              color: '#fff',
            }}
          >
            {remember && (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 12l5 5L20 6" />
              </svg>
            )}
          </span>
          <span className="text-[13.5px]" style={{ color: LABEL }}>
            Keep me signed in on this workstation
          </span>
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="sr-only"
          />
        </label>

        {/* Character CAPTCHA */}
        <CaptchaField verified={captchaVerified} setVerified={setCaptchaVerified} />

        {/* Sign in CTA — muted while captcha unverified */}
        <button
          type="submit"
          disabled={submitDisabled}
          className="mt-1 flex items-center justify-center gap-[10px] border-0 font-semibold text-white"
          style={{
            height: 54,
            borderRadius: 14,
            cursor: submitting
              ? 'wait'
              : captchaVerified
                ? 'pointer'
                : 'not-allowed',
            background: captchaVerified
              ? `linear-gradient(180deg, ${AMBER} 0%, ${AMBER_HOVER} 100%)`
              : `linear-gradient(180deg, ${AMBER}80 0%, ${AMBER_HOVER}80 100%)`,
            fontFamily: "'Sora', system-ui, sans-serif",
            fontSize: 15.5,
            letterSpacing: '0.02em',
            boxShadow: `0 12px 28px -8px ${AMBER}80, inset 0 1px 0 rgba(255,255,255,0.35)`,
            transition: 'transform 180ms ease, box-shadow 180ms ease, background 220ms ease',
            transform: submitting ? 'scale(0.99)' : 'scale(1)',
          }}
        >
          {submitting ? (
            <>
              <span
                aria-hidden
                className="inline-block animate-spin rounded-full"
                style={{
                  width: 16,
                  height: 16,
                  border: '2px solid rgba(255,255,255,0.4)',
                  borderTopColor: '#fff',
                }}
              />
              Verifying credentials…
            </>
          ) : (
            <>
              Sign in to claims console
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14" />
                <path d="m13 5 7 7-7 7" />
              </svg>
            </>
          )}
        </button>
      </form>

      {/* Trust footer — centered, single line, ISO 27001 dropped per
          the latest design */}
      <div
        className="mt-[22px] flex items-center justify-center gap-2 pt-[18px] text-[12px]"
        style={{
          color: MUTED,
          borderTop: '1px solid rgba(11,42,44,0.06)',
          letterSpacing: '0.02em',
        }}
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
        <span>HIPAA-aligned · Data resident in India</span>
      </div>
    </div>
  );
}

// =========================================================
// CaptchaField — character CAPTCHA with distorted glyphs.
// Image row (56px) + refresh button (48x56) on top; input
// row (52px) below with shield icon. Matches the design's
// CaptchaField verbatim. Verification is browser-only — the
// server never receives the captcha; it just gates the
// Sign-in button.
// =========================================================
const CAPTCHA_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function genCode(): string {
  let out = '';
  for (let i = 0; i < 6; i += 1) {
    out += CAPTCHA_CHARS[Math.floor(Math.random() * CAPTCHA_CHARS.length)];
  }
  return out;
}

function CaptchaField({
  verified,
  setVerified,
}: {
  verified: boolean;
  setVerified: (v: boolean) => void;
}): JSX.Element {
  const [code, setCode] = useState<string>(() => genCode());
  const [value, setValue] = useState('');
  const [shake, setShake] = useState(false);
  const [focused, setFocused] = useState(false);

  // Deterministic per-character visual jitter, recomputed when code changes.
  const styled = useMemo(() => {
    return code.split('').map((ch, i) => ({
      ch,
      rot: ((i * 37 + ch.charCodeAt(0)) % 41) - 20,
      dy: ((i * 13 + ch.charCodeAt(0)) % 11) - 5,
      skew: ((i * 23 + ch.charCodeAt(0)) % 17) - 8,
      hue: i % 2 === 0 ? TEAL : TEAL_DEEP,
    }));
  }, [code]);

  const refresh = useCallback(() => {
    setCode(genCode());
    setValue('');
    setVerified(false);
  }, [setVerified]);

  useEffect(() => {
    if (value.length === code.length) {
      if (value.toUpperCase() === code) {
        setVerified(true);
      } else {
        setVerified(false);
        setShake(true);
        const t = setTimeout(() => setShake(false), 400);
        return () => clearTimeout(t);
      }
    } else {
      setVerified(false);
    }
    return undefined;
  }, [value, code, setVerified]);

  const trackBg =
    'linear-gradient(135deg, rgba(255,255,255,0.85) 0%, rgba(238,244,245,0.85) 100%)';
  const trackBorder = 'rgba(11,42,44,0.10)';

  return (
    <div className="flex flex-col gap-2">
      <div
        className="text-[12px] font-medium uppercase"
        style={{ color: LABEL, letterSpacing: '0.04em' }}
      >
        Security check
      </div>

      {/* Row 1 — captcha image + refresh */}
      <div className="flex gap-[10px]">
        <div
          aria-label={`Captcha: ${code.split('').join(' ')}`}
          className="relative flex flex-1 items-center justify-center overflow-hidden"
          style={{
            height: 56,
            borderRadius: 12,
            background: trackBg,
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            border: `1.5px solid ${trackBorder}`,
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.5)',
            userSelect: 'none',
          }}
        >
          <svg
            width="100%"
            height="100%"
            viewBox="0 0 200 56"
            preserveAspectRatio="none"
            className="pointer-events-none absolute inset-0"
          >
            <path
              d={`M0 ${10 + (code.charCodeAt(0) % 20)} Q 60 ${
                40 + (code.charCodeAt(1) % 10)
              } 120 ${20 + (code.charCodeAt(2) % 18)} T 200 ${
                24 + (code.charCodeAt(3) % 16)
              }`}
              stroke="rgba(11,42,44,0.18)"
              strokeWidth={1.2}
              fill="none"
            />
            <path
              d={`M0 ${36 - (code.charCodeAt(1) % 14)} Q 80 ${
                10 + (code.charCodeAt(2) % 20)
              } 160 ${42 - (code.charCodeAt(3) % 18)} T 200 ${
                30 + (code.charCodeAt(4) % 12)
              }`}
              stroke="rgba(11,42,44,0.18)"
              strokeWidth={1}
              fill="none"
            />
            {styled.map((s, i) => (
              <circle
                key={i}
                cx={20 + i * 30 + (s.rot % 5)}
                cy={28 + s.dy}
                r={1}
                fill="rgba(11,42,44,0.18)"
              />
            ))}
          </svg>
          <div
            className="relative flex"
            style={{
              gap: 2,
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              fontWeight: 700,
              fontSize: 26,
              letterSpacing: 0,
            }}
          >
            {styled.map((s, i) => (
              <span
                key={i}
                className="inline-block"
                style={{
                  transform: `rotate(${s.rot}deg) translateY(${s.dy}px) skewX(${s.skew}deg)`,
                  color: s.hue,
                  textShadow: '0 1px 0 rgba(255,255,255,0.5)',
                }}
              >
                {s.ch}
              </span>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={refresh}
          aria-label="Refresh captcha"
          title="Refresh"
          className="flex cursor-pointer items-center justify-center"
          style={{
            width: 48,
            height: 56,
            borderRadius: 12,
            background: trackBg,
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            border: `1.5px solid ${trackBorder}`,
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.5)',
            color: LABEL,
            transition: 'background 200ms ease',
          }}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 12a9 9 0 1 0 3.5-7.1L3 8" />
            <path d="M3 3v5h5" />
          </svg>
        </button>
      </div>

      {/* Row 2 — input matching email/password style, with shield icon */}
      <div
        className={shake ? 'captcha-shake' : ''}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 14px',
          height: 52,
          borderRadius: 12,
          background: 'rgba(255,255,255,0.65)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          border: `1.5px solid ${
            verified
              ? GREEN_CHECK
              : focused
                ? TEAL
                : 'rgba(11,42,44,0.08)'
          }`,
          boxShadow: focused
            ? `0 0 0 4px ${TEAL_FOCUS_SHADOW}, inset 0 1px 0 rgba(255,255,255,0.6)`
            : 'inset 0 1px 0 rgba(255,255,255,0.5)',
          transition: 'border-color 220ms ease, box-shadow 220ms ease',
        }}
      >
        <span className="flex" style={{ color: TEAL }}>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
        </span>
        <input
          value={value}
          onChange={(e) =>
            setValue(e.target.value.toUpperCase().slice(0, code.length))
          }
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Enter captcha here"
          maxLength={code.length}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 15,
            fontWeight: 600,
            letterSpacing: '0.16em',
            color: TEAL_DEEP,
            textTransform: 'uppercase',
          }}
        />
        {verified && (
          <span
            className="inline-flex shrink-0 items-center justify-center text-white"
            style={{
              width: 20,
              height: 20,
              borderRadius: '50%',
              background: GREEN_CHECK,
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 12l5 5L20 6" />
            </svg>
          </span>
        )}
      </div>
    </div>
  );
}
