'use client';

import { type ButtonHTMLAttributes, type ReactNode } from 'react';

// Stitch-canonical CTA used at the bottom of every auth form.
// Amber gradient pill with a trailing arrow icon that slides on hover.
// Pairs with .btn-cta in tokens.css (gradient + shadow are defined there);
// this component adds the icon and layout.

interface AuthSubmitProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Text shown when not submitting. */
  label: string;
  /** Text shown while submitting (defaults to `${label}…`). */
  loadingLabel?: string;
  submitting?: boolean;
  /** Material icon trailing the label. Defaults to `arrow_forward`. */
  trailingIcon?: string;
  /** Set to false to hide the trailing icon altogether. */
  showTrailingIcon?: boolean;
  /** Extra utility classes (kept narrow — `className` overrides padding/layout if passed). */
  extraClassName?: string;
}

export function AuthSubmit({
  label,
  loadingLabel,
  submitting = false,
  trailingIcon = 'arrow_forward',
  showTrailingIcon = true,
  disabled,
  extraClassName,
  children,
  ...rest
}: AuthSubmitProps): JSX.Element {
  return (
    <button
      type="submit"
      disabled={disabled || submitting}
      className={`btn-cta group w-full ${extraClassName ?? ''}`}
      style={{ padding: '14px 24px', fontSize: '14px' }}
      {...rest}
    >
      <span>{submitting ? (loadingLabel ?? `${label}…`) : (children ?? label)}</span>
      {showTrailingIcon ? (
        <span
          className="material-symbols-outlined ml-2 text-[20px] transition-transform group-hover:translate-x-1"
          style={{ fontVariationSettings: "'FILL' 1" }}
        >
          {trailingIcon}
        </span>
      ) : null}
    </button>
  );
}
