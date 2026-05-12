'use client';

import { type CSSProperties, type ReactNode } from 'react';

// Stitch-canonical glass card used for every (auth)-group page body.
// Renders inside the right-hand pane of (auth)/layout.tsx, which already
// supplies the brand panel and mesh wash. The card itself is a frosted
// surface-container-lowest panel with lit top+left edges (set globally
// on `.glass`) and an optional circular icon header.

type Tone = 'default' | 'success' | 'warning' | 'danger';

interface AuthCardProps {
  /** Material Symbols icon shown above the title in a tinted circle. */
  icon?: string;
  /** Optional uppercase eyebrow above the title. */
  eyebrow?: string;
  title?: string;
  subtitle?: ReactNode;
  /** Tints the card for terminal states. */
  tone?: Tone;
  children: ReactNode;
}

const TONE_BG: Record<Tone, CSSProperties | undefined> = {
  default: undefined,
  success: { background: 'rgba(232, 250, 241, 0.62)', borderColor: 'rgba(16, 122, 87, 0.25)' },
  warning: { background: 'rgba(255, 244, 224, 0.62)', borderColor: 'rgba(237, 139, 0, 0.28)' },
  danger:  { background: 'rgba(254, 242, 242, 0.62)', borderColor: 'rgba(185, 28, 28, 0.22)' },
};

const TONE_ICON: Record<Tone, string> = {
  default: 'bg-primary-container/10 text-primary-container',
  success: 'bg-emerald-500/10 text-emerald-700',
  warning: 'bg-amber-500/10 text-amber-700',
  danger:  'bg-error/10 text-error',
};

export function AuthCard({
  icon,
  eyebrow,
  title,
  subtitle,
  tone = 'default',
  children,
}: AuthCardProps): JSX.Element {
  return (
    <div
      className="glass overflow-hidden rounded-2xl p-8 md:p-10"
      style={TONE_BG[tone]}
    >
      {(icon || eyebrow || title || subtitle) && (
        <header className="mb-8 text-center">
          {icon ? (
            <div
              className={`mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full ${TONE_ICON[tone]}`}
            >
              <span
                className="material-symbols-outlined text-[28px]"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                {icon}
              </span>
            </div>
          ) : null}
          {eyebrow ? (
            <div className="mb-1 text-eyebrow uppercase tracking-eyebrow text-primary">
              {eyebrow}
            </div>
          ) : null}
          {title ? (
            <h2 className="text-h2 font-h2 text-on-surface">{title}</h2>
          ) : null}
          {subtitle ? (
            <p className="mt-2 text-body text-on-surface-variant">{subtitle}</p>
          ) : null}
        </header>
      )}

      {children}
    </div>
  );
}
