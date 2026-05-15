// Shared DigiSparsh logo. The raw PNG has a lot of whitespace
// around the wordmark, so we crop visually by sizing the image
// generously inside a fixed-height box and clipping overflow.
//
// Variants:
//   onLight — used on white/glass surfaces (logo as-is)
//   onDark  — used on the teal sidebar; the logo is wrapped in
//             a soft white pill so the teal letters stay legible
//
// Sizes are kept in the brand layer so every surface uses the
// same proportions.

import Image from 'next/image';

interface LogoProps {
  variant?: 'onLight' | 'onDark';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const HEIGHTS: Record<NonNullable<LogoProps['size']>, number> = {
  sm: 28,
  md: 36,
  lg: 48,
};

export function Logo({
  variant = 'onLight',
  size = 'md',
  className = '',
}: LogoProps): JSX.Element {
  const h = HEIGHTS[size];
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
