import { type ReactNode } from 'react';

// Auth shell — two-panel layout per the Stitch reference.
// Left: deep-teal brand panel with ambient blur orbs, brand pill, headline,
// three feature bullets, and footer. Hidden on small screens; the right
// panel is full-width below the md breakpoint.
// Right: surface-toned form panel with its own mesh wash and a glass card
// containing the page's form (rendered through `children`).

const BULLETS: { icon: string; title: string; body: string }[] = [
  {
    icon: 'check_circle',
    title: 'NHCX Compliant',
    body: 'Seamless integration with the National Health Claims Exchange.',
  },
  {
    icon: 'verified_user',
    title: 'DPDP Ready',
    body: 'Enterprise-grade security adhering to the latest privacy regulations.',
  },
  {
    icon: 'bolt',
    title: 'Accelerated Settlements',
    body: 'Reduce claim processing time through AI-driven clinical transparency.',
  },
];

export default function AuthLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <main className="min-h-screen flex flex-col md:flex-row bg-background text-on-surface antialiased">
      {/* Brand panel (md+) */}
      <aside className="relative hidden md:flex md:w-[45%] lg:w-1/2 shrink-0 overflow-hidden flex-col justify-between p-12 lg:p-24 bg-gradient-to-br from-primary to-on-primary-fixed-variant">
        {/* Ambient glow orbs */}
        <div
          aria-hidden
          className="pointer-events-none absolute -top-32 -left-32 w-96 h-96 rounded-full bg-primary-fixed/20 blur-[100px]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-32 -right-32 w-96 h-96 rounded-full bg-secondary-container/10 blur-[100px]"
        />

        {/* Top: brand pill + headline + bullets */}
        <div className="relative z-10 flex flex-col items-start">
          <div className="inline-flex items-center rounded-full border border-white/20 bg-surface-container-lowest/10 px-5 py-2 text-h3 font-black tracking-tighter text-on-primary-container shadow-lg shadow-primary/20 backdrop-blur-md">
            <span
              className="material-symbols-outlined mr-2"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              health_and_safety
            </span>
            DIGI SPARSH
          </div>

          <h1 className="mt-16 max-w-md text-h1-mobile md:text-h1 leading-tight text-balance text-on-primary lg:mt-24">
            Claims, simplified for Indian hospitals.
          </h1>

          <ul className="mt-12 space-y-6">
            {BULLETS.map((b) => (
              <li key={b.icon} className="flex items-start">
                <span
                  className="material-symbols-outlined mr-4 mt-0.5 text-secondary-container"
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  {b.icon}
                </span>
                <div>
                  <span className="block text-body font-semibold text-on-primary">{b.title}</span>
                  <span className="text-body-sm text-on-primary/80">{b.body}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* Footer */}
        <div className="relative z-10 mt-16 text-body-sm text-on-primary/60">
          © {new Date().getFullYear()} DigiSparsh Healthcare Solutions
        </div>
      </aside>

      {/* Form panel */}
      <section className="relative flex w-full md:w-[55%] lg:w-1/2 flex-1 items-center justify-center overflow-hidden bg-surface p-6 md:p-12">
        {/* Mesh wash behind the card */}
        <div aria-hidden className="pointer-events-none absolute inset-0 z-0 opacity-60">
          <div className="absolute left-1/4 top-1/4 h-[400px] w-[400px] rounded-full bg-primary-fixed-dim/30 blur-[120px] mix-blend-multiply" />
          <div className="absolute bottom-1/4 right-1/4 h-[500px] w-[500px] rounded-full bg-tertiary-fixed/40 blur-[140px] mix-blend-multiply" />
          <div className="absolute left-1/2 top-1/2 h-[600px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-surface-container-high/50 blur-[100px]" />
        </div>

        <div className="relative z-10 w-full max-w-[440px]">{children}</div>
      </section>
    </main>
  );
}
