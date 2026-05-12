'use client';

import {
  forwardRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';

// Shared input field for auth pages. Renders a Stitch-style input with:
//   - eyebrow label (uppercase, tracked-out)
//   - optional leading Material Symbols icon
//   - password-mode adds a trailing visibility toggle and switches type
//   - optional right adornment (anchor, hint, etc.) shown next to the label
//
// Forwards refs so native form behaviour (autofocus, autocomplete, validity)
// remains unchanged versus the previous inline <input>s.

type BaseInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

interface AuthFieldProps extends BaseInputProps {
  /** Field label rendered as an eyebrow above the input. */
  label: string;
  /** Material Symbols icon name for the leading slot. */
  icon?: string;
  /** Sets type="password" and renders an eye toggle on the right. */
  password?: boolean;
  /** Optional right-hand adornment shown next to the label (e.g. Forgot link). */
  labelAside?: ReactNode;
  /** Aligns text centrally and applies tabular-nums (for OTP / codes). */
  centered?: boolean;
}

export const AuthField = forwardRef<HTMLInputElement, AuthFieldProps>(function AuthField(
  { label, icon, password, labelAside, centered, className, id, ...rest },
  ref,
) {
  const [reveal, setReveal] = useState(false);
  const inputType = password ? (reveal ? 'text' : 'password') : (rest as { type?: string }).type ?? 'text';
  const inputId = id ?? rest.name;

  return (
    <div className="space-y-1.5">
      <div className="ml-1 flex items-center justify-between">
        <label
          htmlFor={inputId}
          className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant"
        >
          {label}
        </label>
        {labelAside}
      </div>
      <div className="relative">
        {icon ? (
          <span className="material-symbols-outlined pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[20px] text-outline/60">
            {icon}
          </span>
        ) : null}
        <input
          ref={ref}
          id={inputId}
          type={inputType}
          className={[
            'w-full rounded-lg border border-white bg-surface-container-lowest/50',
            'py-3 pr-4 text-body text-on-surface placeholder:text-outline-variant',
            'shadow-sm outline-none transition-all',
            'focus:border-primary-container focus:bg-surface-container-lowest focus:ring-1 focus:ring-primary-container',
            icon ? 'pl-10' : 'pl-4',
            password ? 'pr-10' : '',
            centered ? 'text-center font-mono tabular-nums tracking-wider' : '',
            className ?? '',
          ].join(' ')}
          {...rest}
        />
        {password ? (
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            aria-label={reveal ? 'Hide password' : 'Show password'}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-outline/60 transition-colors hover:text-on-surface-variant"
          >
            <span className="material-symbols-outlined text-[20px]">
              {reveal ? 'visibility' : 'visibility_off'}
            </span>
          </button>
        ) : null}
      </div>
    </div>
  );
});
