// Shared DigiSparsh logo.
//
// Variants:
//   onLight — teal wordmark on white/glass surfaces (logo as-is)
//   onDark  — teal wordmark wrapped in a soft white pill (legacy;
//             kept for surfaces that want the boxed treatment)
//   onTeal  — white wordmark (orange ₹ preserved) directly on the
//             teal sidebar, no pill / no background box
//
// onLight/onDark crop the near-square teal art horizontally so the
// wordmark fills the box. onTeal uses the pre-cropped white-on-
// transparent asset and renders it `contain` so it's never clipped.

import Image from 'next/image';

interface LogoProps {
  variant?: 'onLight' | 'onDark' | 'onTeal';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

const HEIGHTS: Record<NonNullable<LogoProps['size']>, number> = {
  sm: 28,
  md: 36,
  lg: 48,
  xl: 72,
};

export function Logo({
  variant = 'onLight',
  size = 'md',
  className = '',
}: LogoProps): JSX.Element {
  const h = HEIGHTS[size];

  // onTeal — white-on-transparent wordmark, contained (no crop). The
  // source art is 164×95 (~1.73:1), so we size the box to that aspect
  // at the requested height and let `contain` letterbox cleanly.
  if (variant === 'onTeal') {
    const w = Math.round(h * (164 / 95));
    return (
      <div
        className={`inline-flex items-center justify-center ${className}`}
        aria-label="DigiSparsh"
      >
        <div className="relative" style={{ height: h, width: w }}>
          <Image
            src="/digisparsh-logo-white.png"
            alt="DigiSparsh"
            fill
            priority
            sizes={`${w}px`}
            style={{ objectFit: 'contain', objectPosition: 'center' }}
          />
        </div>
      </div>
    );
  }

  // Logo art is a near-square; we crop horizontally to ~2.4× the
  // height so the wordmark fills the box without empty margins.
  const w = Math.round(h * 2.4);

  const wrapper =
    variant === 'onDark'
      ? 'inline-flex items-center justify-center rounded-md bg-white/95 px-3 py-1.5 shadow-md ring-1 ring-white/40'
      : 'inline-flex items-center justify-center';

  return (
    <div className={`${wrapper} ${className}`} aria-label="DigiSparsh">
      <div className="relative overflow-hidden" style={{ height: h, width: w }}>
        <Image
          src="/digisparsh-logo.png"
          alt="DigiSparsh"
          fill
          priority
          sizes={`${w}px`}
          style={{ objectFit: 'cover', objectPosition: 'center' }}
        />
      </div>
    </div>
  );
}
