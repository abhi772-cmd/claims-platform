'use client';

// Promise-based confirm + prompt dialogs.
//
// Replaces the browser `window.confirm()` / `window.prompt()` calls
// that CLAUDE.md rule #6 explicitly forbids ("No browser alert(),
// confirm(), prompt()..."). Modeled on ErrorModalProvider — a
// single global provider exposes hooks that return Promises so
// caller code reads like async/await without inline render logic.
//
// Usage:
//   const confirm = useConfirm();
//   if (await confirm({ title: '…', body: '…', confirmLabel: 'Notify' })) { … }
//
//   const prompt = usePrompt();
//   const reason = await prompt({ title: '…', label: '…', minLength: 10 });
//   if (reason !== null) { … }

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

// ===========================================================
// Confirm
// ===========================================================

export type ConfirmTone = 'primary' | 'danger' | 'warning';

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
}

type ConfirmState = ConfirmOptions & {
  resolve: (ok: boolean) => void;
};

// ===========================================================
// Prompt
// ===========================================================

export interface PromptOptions {
  title: string;
  // Short description above the input.
  body?: ReactNode;
  // Inline label for the text field.
  label: string;
  placeholder?: string;
  // Reject the input below this length. The submit button stays
  // disabled until the value is at least minLength characters.
  minLength?: number;
  maxLength?: number;
  // Show a multi-line textarea instead of a single-line input.
  multiline?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
}

type PromptState = PromptOptions & {
  resolve: (value: string | null) => void;
};

// ===========================================================
// Context
// ===========================================================

interface ConfirmDialogContextValue {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
}

const ConfirmDialogContext = createContext<ConfirmDialogContextValue | null>(null);

export function ConfirmDialogProvider({ children }: { children: ReactNode }): JSX.Element {
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [promptState, setPromptState] = useState<PromptState | null>(null);

  const confirm = useCallback(
    (opts: ConfirmOptions): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        setConfirmState({ ...opts, resolve });
      }),
    [],
  );
  const prompt = useCallback(
    (opts: PromptOptions): Promise<string | null> =>
      new Promise<string | null>((resolve) => {
        setPromptState({ ...opts, resolve });
      }),
    [],
  );

  const closeConfirm = useCallback(
    (ok: boolean) => {
      if (confirmState) confirmState.resolve(ok);
      setConfirmState(null);
    },
    [confirmState],
  );
  const closePrompt = useCallback(
    (value: string | null) => {
      if (promptState) promptState.resolve(value);
      setPromptState(null);
    },
    [promptState],
  );

  const value = useMemo<ConfirmDialogContextValue>(
    () => ({ confirm, prompt }),
    [confirm, prompt],
  );

  return (
    <ConfirmDialogContext.Provider value={value}>
      {children}
      {confirmState ? (
        <ConfirmDialog state={confirmState} onClose={closeConfirm} />
      ) : null}
      {promptState ? (
        <PromptDialog state={promptState} onClose={closePrompt} />
      ) : null}
    </ConfirmDialogContext.Provider>
  );
}

export function useConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(ConfirmDialogContext);
  if (!ctx) throw new Error('useConfirm must be used within ConfirmDialogProvider');
  return ctx.confirm;
}
export function usePrompt(): (opts: PromptOptions) => Promise<string | null> {
  const ctx = useContext(ConfirmDialogContext);
  if (!ctx) throw new Error('usePrompt must be used within ConfirmDialogProvider');
  return ctx.prompt;
}

// ===========================================================
// Components
// ===========================================================

const TONE_STYLE: Record<ConfirmTone, { btnCls: string; iconBg: string; iconColor: string; icon: string }> = {
  primary: {
    btnCls: 'bg-primary text-on-primary hover:bg-primary/90',
    iconBg: 'bg-primary/10',
    iconColor: 'text-primary',
    icon: 'help',
  },
  warning: {
    btnCls: 'bg-amber-600 text-white hover:bg-amber-700',
    iconBg: 'bg-amber-100',
    iconColor: 'text-amber-700',
    icon: 'warning',
  },
  danger: {
    btnCls: 'bg-red-600 text-white hover:bg-red-700',
    iconBg: 'bg-red-100',
    iconColor: 'text-red-700',
    icon: 'gpp_maybe',
  },
};

function ConfirmDialog({
  state,
  onClose,
}: {
  state: ConfirmState;
  onClose: (ok: boolean) => void;
}): JSX.Element {
  const tone = TONE_STYLE[state.tone ?? 'primary'];

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={() => onClose(false)}
    >
      <div
        className="w-full max-w-md rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 px-6 pt-6">
          <div
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${tone.iconBg}`}
          >
            <span
              className={`material-symbols-outlined ${tone.iconColor}`}
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              {tone.icon}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="confirm-title" className="text-h3 font-h3 text-on-surface">
              {state.title}
            </h2>
            <div className="mt-2 text-body-sm text-on-surface-variant">{state.body}</div>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2 border-t border-outline-variant/20 bg-surface-container-lowest/40 px-6 py-3">
          <button
            type="button"
            onClick={() => onClose(false)}
            className="rounded-md px-4 py-2 text-body-sm font-medium text-on-surface-variant hover:bg-surface-container-low"
          >
            {state.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            onClick={() => onClose(true)}
            autoFocus
            className={`rounded-md px-4 py-2 text-body-sm font-medium ${tone.btnCls}`}
          >
            {state.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

function PromptDialog({
  state,
  onClose,
}: {
  state: PromptState;
  onClose: (value: string | null) => void;
}): JSX.Element {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const min = state.minLength ?? 0;
  const canSubmit = value.trim().length >= min;
  const submit = (): void => {
    if (canSubmit) onClose(value.trim());
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="prompt-title"
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={() => onClose(null)}
    >
      <div
        className="w-full max-w-md rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-6">
          <h2 id="prompt-title" className="text-h3 font-h3 text-on-surface">
            {state.title}
          </h2>
          {state.body ? (
            <div className="mt-2 text-body-sm text-on-surface-variant">{state.body}</div>
          ) : null}
        </div>
        <div className="space-y-1.5 px-6 pt-4">
          <label className="text-eyebrow uppercase tracking-eyebrow text-on-surface-variant">
            {state.label}
          </label>
          {state.multiline ? (
            <textarea
              ref={(el): void => {
                inputRef.current = el;
              }}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={state.placeholder}
              rows={4}
              maxLength={state.maxLength}
              className="w-full resize-none rounded-md border border-outline-variant/40 bg-surface-container-lowest/60 px-3 py-2 text-body-sm text-on-surface outline-none focus:border-primary focus:ring-1 focus:ring-primary-container"
            />
          ) : (
            <input
              ref={(el): void => {
                inputRef.current = el;
              }}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) submit();
              }}
              placeholder={state.placeholder}
              maxLength={state.maxLength}
              className="w-full rounded-md border border-outline-variant/40 bg-surface-container-lowest/60 px-3 py-2 text-body-sm text-on-surface outline-none focus:border-primary focus:ring-1 focus:ring-primary-container"
            />
          )}
          {min > 0 ? (
            <p
              className={
                value.trim().length === 0
                  ? 'text-[11px] text-on-surface-variant'
                  : canSubmit
                    ? 'text-[11px] text-green-700'
                    : 'text-[11px] text-amber-700'
              }
            >
              {value.trim().length} / minimum {min} characters
            </p>
          ) : null}
        </div>
        <div className="mt-5 flex justify-end gap-2 border-t border-outline-variant/20 bg-surface-container-lowest/40 px-6 py-3">
          <button
            type="button"
            onClick={() => onClose(null)}
            className="rounded-md px-4 py-2 text-body-sm font-medium text-on-surface-variant hover:bg-surface-container-low"
          >
            {state.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="rounded-md bg-primary px-4 py-2 text-body-sm font-medium text-on-primary hover:bg-primary/90 disabled:opacity-50"
          >
            {state.confirmLabel ?? 'Submit'}
          </button>
        </div>
      </div>
    </div>
  );
}
