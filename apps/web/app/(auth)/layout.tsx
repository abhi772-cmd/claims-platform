import { type ReactNode } from 'react';

// Auth shell — "Split Premium" handoff from Claude Design
// (login-2/project/DigiSparsh Login.html).
//   Left  (56% on lg+): teal hero panel with decorative orbs + faint
//                       grid mask, centered DigiSparsh white wordmark,
//                       editorial headline ("A digital touch / for
//                       every claim." — second line in Newsreader
//                       italic amber), sub-copy, and three check
//                       bullets above a thin top-border bottom band.
//   Right (44% on lg+): pale gradient canvas. Each child page renders
//                       its own glass card overlapping the panel
//                       boundary via `lg:-ml-24` (mirrors the design's
//                       marginLeft: -120 on the form card).
//
// Tokens (brand-locked):
//   primary teal      #008F99 (gradient #006E76 → #008F99 → #0AA6A8)
//   secondary amber   #FAA719
//   deep ink          #0B2A2C
//   muted             #6B8589

export default function AuthLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <main className="font-auth flex min-h-screen flex-col antialiased lg:flex-row">
      {/* Hero panel — lg+. Flat brand teal #008F99 with softened white
          glows at corners (per the latest design handoff — no gradient,
          orbs at 10/8/6% white opacity so the surface reads as one
          solid teal). */}
      <aside
        className="relative hidden shrink-0 overflow-hidden text-white lg:flex lg:w-[56%] lg:flex-col lg:px-[72px] lg:py-14"
        style={{ background: '#008F99' }}
      >
        {/* Softened white glow orbs at corners */}
        <div
          aria-hidden
          className="pointer-events-none absolute"
          style={{
            top: -120,
            left: -120,
            width: 460,
            height: 460,
            background:
              'radial-gradient(closest-side, rgba(255,255,255,0.10), rgba(255,255,255,0))',
            filter: 'blur(20px)',
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute"
          style={{
            bottom: -160,
            right: -100,
            width: 520,
            height: 520,
            background:
              'radial-gradient(closest-side, rgba(255,255,255,0.08), rgba(255,255,255,0))',
            filter: 'blur(20px)',
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute"
          style={{
            top: 240,
            right: 120,
            width: 280,
            height: 280,
            background:
              'radial-gradient(closest-side, rgba(255,255,255,0.06), rgba(255,255,255,0))',
            filter: 'blur(10px)',
          }}
        />

        {/* Faint grid mask — 32px cells, radial fade so it only shows
            through the left-of-center band */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              'linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)',
            backgroundSize: '32px 32px',
            WebkitMaskImage:
              'radial-gradient(circle at 30% 50%, #000 0%, transparent 75%)',
            maskImage:
              'radial-gradient(circle at 30% 50%, #000 0%, transparent 75%)',
          }}
        />

        {/* DigiSparsh wordmark — centered, 160px, with soft shadow.
            Block sits higher than the previous iteration. */}
        <div className="relative mb-6 mt-[70px] flex justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/digisparsh-logo-white.png"
            alt="DigiSparsh"
            className="block h-[160px] w-auto"
            style={{ filter: 'drop-shadow(0 8px 20px rgba(0,30,32,0.32))' }}
          />
        </div>

        {/* Headline + sub (mt-10 pushes the text block down 40px under
            the larger logo) */}
        <div className="relative mt-10 max-w-[540px]">
          <div className="mb-[18px] text-[12px] font-semibold uppercase tracking-[0.22em] text-white/70">
            Hospital Claims Platform
          </div>
          <h1
            className="m-0 text-[56px] font-semibold leading-[1.05]"
            style={{ letterSpacing: '-0.02em' }}
          >
            A Digital Touch
            <br />
            <span
              className="font-auth-italic"
              style={{ color: '#FAA719' }}
            >
              for every claim.
            </span>
          </h1>
          <p className="mt-[22px] max-w-[460px] text-[17px] font-light leading-[1.55] text-white/85">
            One workspace for pre-auth, discharge summaries, and TPA
            settlements — so your team can stay focused on patients.
          </p>
        </div>

        {/* Bottom band — 3 check bullets above a hairline border */}
        <div
          className="relative mt-auto flex flex-col gap-[14px] pt-[26px]"
          style={{ borderTop: '1px solid rgba(255,255,255,0.16)' }}
        >
          {[
            'Pre-auth in under 3 hours',
            'Auto-fetch from HIS/EMR',
            'Real-time TPA tracking',
          ].map((t) => (
            <div key={t} className="flex items-center gap-3 text-[15.5px]">
              <span
                aria-hidden
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
                style={{
                  background: 'rgba(255,255,255,0.14)',
                  border: '1px solid rgba(255,255,255,0.28)',
                  color: '#FAA719',
                }}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 12l5 5L20 6" />
                </svg>
              </span>
              <span
                className="font-normal text-white"
                style={{ letterSpacing: '0.01em' }}
              >
                {t}
              </span>
            </div>
          ))}
        </div>
      </aside>

      {/* Form canvas — pale gradient. The orbs live in a clipped
          wrapper so the section itself can stay `overflow-visible` —
          that's what lets the child glass card extend leftward over
          the teal hero (mirrors the design's `marginLeft: -120` on
          the card). On mobile/tablet the card sits centered with no
          overlap. */}
      <section
        className="relative flex w-full flex-1 items-center justify-center px-4 py-12 sm:px-6 lg:w-[44%] lg:justify-start lg:px-0"
        style={{
          background: 'linear-gradient(180deg, #F7FAFB 0%, #EEF4F5 100%)',
        }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden"
        >
          <div
            className="absolute"
            style={{
              top: 80,
              right: -120,
              width: 380,
              height: 380,
              background:
                'radial-gradient(closest-side, rgba(250,167,25,0.18), rgba(250,167,25,0))',
              filter: 'blur(20px)',
            }}
          />
          <div
            className="absolute"
            style={{
              bottom: 40,
              right: 60,
              width: 220,
              height: 220,
              background:
                'radial-gradient(closest-side, rgba(0,143,153,0.22), rgba(0,143,153,0))',
              filter: 'blur(12px)',
            }}
          />
        </div>

        {/* Form wrapper. Inline-style negative margin guarantees the
            -120px overlap even if Tailwind JIT misses the arbitrary
            value on a cold start. Width pinned to 460px (the design's
            card width). */}
        <div
          className="relative z-10 w-full max-w-[460px] lg:w-[460px] lg:max-w-none lg:flex-none lg:[margin-left:-120px]"
        >
          {children}
        </div>
      </section>
    </main>
  );
}
