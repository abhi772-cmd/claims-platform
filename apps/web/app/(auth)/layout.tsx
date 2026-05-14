import { type ReactNode } from 'react';

// Auth shell — Stitch "Premium Glassmorphism Login Page" reference (HTML
// version). Single column on mobile/tablet, 50/50 split on lg+.
//   Left:  brand teal #2a8f9d with the bearded-admin illustration.
//   Right: pale cyan #d1eaec, page renders a translucent glass card on top.

export default function AuthLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <main className="flex min-h-screen flex-col antialiased lg:flex-row">
      {/* Illustration panel — lg+ only */}
      <aside
        className="relative hidden shrink-0 overflow-hidden lg:block lg:w-1/2"
        style={{ backgroundColor: '#2a8f9d' }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/auth-illustration-premium.png"
          alt="Hospital administrator working at a desk"
          className="h-full w-full object-cover object-center"
        />
      </aside>

      {/* Form canvas — pale cyan background with optional decorative orbs.
          Vertical padding gives breathing room for the overhanging logo
          badge and lets short / landscape viewports scroll naturally. */}
      <section
        className="relative flex w-full flex-1 items-center justify-center overflow-hidden px-4 py-12 sm:px-6 lg:w-1/2 lg:px-10"
        style={{ backgroundColor: '#d1eaec' }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute right-1/4 top-1/4 hidden h-72 w-72 rounded-full bg-white/60 blur-3xl filter sm:block"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-1/4 left-1/4 hidden h-80 w-80 rounded-full bg-white/40 blur-3xl filter sm:block"
        />

        <div className="relative z-10 w-full max-w-md">{children}</div>
      </section>
    </main>
  );
}
