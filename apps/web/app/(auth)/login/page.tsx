'use client';

import { LoginRequestSchema } from '@claims/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { useErrorModal } from '../../../components/modals/ErrorModal/ErrorModalProvider';
import { AuthApi } from '../../../lib/api/auth.api';

// Visual: Stitch "Premium Glassmorphism Login Page" — verbatim port of the
// generated HTML, retrofitted to drive the real auth flow. Email + password
// go through AuthApi.login + LoginRequestSchema. Captcha is browser-only.

const CAPTCHA_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const TEAL = '#2a8f9d';        // Stitch left panel / heading / icons / focus
const PALE = '#d1eaec';        // Stitch right panel + logo ring
const AMBER = '#f89e1a';       // Stitch submit button
const AMBER_HOVER = '#e68e14';
const AMBER_ACCENT = '#f7a325'; // refresh icon

function makeCaptcha(): string {
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    out += CAPTCHA_ALPHABET[Math.floor(Math.random() * CAPTCHA_ALPHABET.length)];
  }
  return out;
}

export default function LoginPage(): JSX.Element {
  const router = useRouter();
  const { showApiError, showError } = useErrorModal();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [captcha, setCaptcha] = useState('');
  const [captchaAnswer, setCaptchaAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setCaptcha(makeCaptcha());
  }, []);

  function refreshCaptcha(): void {
    setCaptcha(makeCaptcha());
    setCaptchaAnswer('');
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (captchaAnswer.trim().toLowerCase() !== captcha.toLowerCase()) {
      showError('VALIDATION_FAILED', 'The captcha you entered does not match.');
      refreshCaptcha();
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
      refreshCaptcha();
    } finally {
      setSubmitting(false);
    }
  }

  // Glass input styling, matching Stitch's .glass-input
  const inputCls =
    'w-full rounded-lg py-2 pl-3 pr-10 text-sm text-gray-800 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-[#2a8f9d]';
  const inputStyle = {
    background: 'rgba(255, 255, 255, 0.3)',
    border: '1px solid rgba(255, 255, 255, 0.7)',
  } as const;

  return (
    <div
      className="relative mt-12 w-full rounded-2xl p-8"
      style={{
        background: 'rgba(255, 255, 255, 0.25)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: '1px solid rgba(255, 255, 255, 0.6)',
        boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.1)',
      }}
    >
      {/* Logo badge — overlapping the top of the card */}
      <div
        className="absolute -top-16 left-1/2 flex h-32 w-32 -translate-x-1/2 items-center justify-center rounded-full bg-white shadow-lg"
        style={{ border: `4px solid ${PALE}` }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/digisparsh-logo-tight.png"
          alt="DigiSparsh"
          className="h-auto w-20 object-contain"
        />
      </div>

      <div className="mt-14">
        <h2
          className="mb-8 text-center text-2xl font-semibold"
          style={{ color: TEAL }}
        >
          Login Your Account
        </h2>

        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          {/* Email */}
          <div>
            <label
              htmlFor="email"
              className="mb-1 ml-1 block text-xs font-medium text-gray-700"
            >
              Email ID
            </label>
            <div className="relative">
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                aria-label="Email Address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Enter your email"
                className={inputCls}
                style={inputStyle}
              />
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
                <span
                  className="material-symbols-outlined text-[18px]"
                  style={{ color: TEAL }}
                >
                  account_circle
                </span>
              </div>
            </div>
          </div>

          {/* Password */}
          <div>
            <label
              htmlFor="password"
              className="mb-1 ml-1 block text-xs font-medium text-gray-700"
            >
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                name="password"
                type={reveal ? 'text' : 'password'}
                autoComplete="current-password"
                required
                aria-label="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                className={inputCls}
                style={inputStyle}
              />
              <button
                type="button"
                onClick={() => setReveal((r) => !r)}
                aria-label={reveal ? 'Hide password' : 'Show password'}
                className="absolute inset-y-0 right-0 flex cursor-pointer items-center pr-3 transition-opacity hover:opacity-80"
                style={{ color: TEAL }}
              >
                <span className="material-symbols-outlined text-[18px]">
                  {reveal ? 'visibility' : 'visibility_off'}
                </span>
              </button>
            </div>
          </div>

          {/* CAPTCHA */}
          <div className="pt-2">
            <div className="mb-2 flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
              <label
                htmlFor="captcha"
                className="ml-1 block text-xs font-medium text-gray-700"
              >
                Enter The CAPTCHA Below:
              </label>
              <div className="flex items-center space-x-2 self-start sm:self-auto">
                <div
                  aria-hidden
                  className="-skew-x-6 transform rounded border border-gray-200 bg-white px-4 py-1 shadow-inner"
                >
                  <span
                    className="text-lg font-bold tracking-[2px] text-gray-800"
                    style={{
                      fontFamily: "'Courier New', Courier, monospace",
                      textShadow: '1px 1px 0 #000',
                    }}
                  >
                    {captcha || '———————'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={refreshCaptcha}
                  aria-label="Refresh captcha"
                  className="transition-transform hover:rotate-180 focus:outline-none"
                  style={{ color: AMBER_ACCENT }}
                >
                  <span className="material-symbols-outlined">refresh</span>
                </button>
              </div>
            </div>
            <input
              id="captcha"
              name="captcha"
              type="text"
              inputMode="text"
              autoComplete="off"
              required
              aria-label="Enter captcha"
              value={captchaAnswer}
              onChange={(e) => setCaptchaAnswer(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm text-gray-800 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-[#2a8f9d]"
              style={inputStyle}
            />
          </div>

          {/* Forgot password */}
          <div className="mt-2 text-center">
            <Link
              href="/forgot-password"
              className="text-xs font-medium hover:underline"
              style={{ color: TEAL }}
            >
              Forgot your Password?
            </Link>
          </div>

          {/* Submit */}
          <button
            type="submit"
            disabled={submitting}
            className="mt-2 w-full rounded-lg py-2.5 font-medium text-white shadow-md transition duration-200 disabled:cursor-not-allowed disabled:opacity-60"
            style={{ backgroundColor: AMBER }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = AMBER_HOVER;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = AMBER;
            }}
          >
            {submitting ? 'Signing in…' : 'Login'}
          </button>
        </form>
      </div>
    </div>
  );
}
