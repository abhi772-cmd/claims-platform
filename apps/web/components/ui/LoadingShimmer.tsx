'use client';

// LoadingShimmer — single source of truth for in-flight loading
// states across the app. Replaces the ad-hoc "Loading…" glass cards
// with a structurally-correct shimmer that previews the layout the
// real content will fill, so the page doesn't shift on data arrival.
//
// Variants:
//   - 'page' — full-width glass shell with eyebrow + heading + body
//              shimmer bars. Use for whole-page loading states
//              (dashboard, case detail, variance, etc.).
//   - 'row'  — list of skeleton row pills, suitable for a table or
//              list mid-load. `rows` defaults to 5; callers pass 3-8
//              depending on the typical full-page count.
//
// `label` is the accessibility text announced to screen readers and
// the visual fallback when prefers-reduced-motion is on.

import { type JSX } from 'react';

interface LoadingShimmerProps {
  variant: 'page' | 'row';
  label: string;
  rows?: number;
}

export function LoadingShimmer({ variant, label, rows = 5 }: LoadingShimmerProps): JSX.Element {
  if (variant === 'row') {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-busy="true"
        aria-label={label}
        className="flex flex-col gap-2"
      >
        {Array.from({ length: Math.max(1, rows) }).map((_, i) => (
          <div
            key={i}
            className="loading-shimmer-bar h-12 w-full rounded-lg"
          />
        ))}
        <span className="sr-only">{label}</span>
      </div>
    );
  }
  // 'page' variant.
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label}
      className="glass flex flex-col gap-4 rounded-xl p-6"
    >
      <div className="loading-shimmer-bar h-3 w-24 rounded-full" />
      <div className="loading-shimmer-bar h-7 w-2/3 rounded-md" />
      <div className="flex flex-col gap-2">
        <div className="loading-shimmer-bar h-3 w-full rounded-full" />
        <div className="loading-shimmer-bar h-3 w-5/6 rounded-full" />
        <div className="loading-shimmer-bar h-3 w-4/6 rounded-full" />
      </div>
      <span className="sr-only">{label}</span>
    </div>
  );
}
