'use client';

// Styled success / info / warning toasts. Replaces stray
// `window.alert()` calls used for transient confirmations
// (e.g. "Scan complete: 3 new incidents found"). CLAUDE.md rule
// #6 explicitly forbids browser alert(), and these messages
// don't warrant a full modal.
//
// Auto-dismiss after `durationMs` (default 4000). Stacks up to
// 4 visible toasts at the bottom-right; older toasts evict
// FIFO when the queue overflows.

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

export type ToastTone = 'success' | 'info' | 'warning';

interface ToastOptions {
  tone?: ToastTone;
  message: string;
  durationMs?: number;
}

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastContextValue {
  showToast: (opts: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const MAX_VISIBLE = 4;
const DEFAULT_DURATION_MS = 4000;

const TONE_STYLE: Record<ToastTone, { cls: string; iconCls: string; icon: string }> = {
  success: {
    cls: 'border-green-200 bg-green-50',
    iconCls: 'text-green-700',
    icon: 'check_circle',
  },
  info: {
    cls: 'border-blue-200 bg-blue-50',
    iconCls: 'text-blue-700',
    icon: 'info',
  },
  warning: {
    cls: 'border-amber-200 bg-amber-50',
    iconCls: 'text-amber-700',
    icon: 'warning',
  },
};

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Monotonically-increasing id generator. Keys must be stable
  // across renders even when message text is identical.
  const idRef = useRef(0);

  const dismiss = useCallback((id: number): void => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (opts: ToastOptions): void => {
      idRef.current += 1;
      const id = idRef.current;
      const toast: Toast = {
        id,
        tone: opts.tone ?? 'success',
        message: opts.message,
      };
      setToasts((prev) => {
        // FIFO eviction when the queue is over MAX_VISIBLE.
        const next = [...prev, toast];
        return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
      });
      const ms = opts.durationMs ?? DEFAULT_DURATION_MS;
      window.setTimeout(() => dismiss(id), ms);
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toasts.length > 0 ? (
        <div className="fixed bottom-4 right-4 z-modal flex max-w-sm flex-col gap-2">
          {toasts.map((t) => (
            <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
          ))}
        </div>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast(): (opts: ToastOptions) => void {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx.showToast;
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: () => void;
}): JSX.Element {
  const style = TONE_STYLE[toast.tone];
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    // Trigger the enter transition on next paint so the toast
    // animates in rather than appearing instantly.
    const id = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(id);
  }, []);
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-start gap-3 rounded-xl border px-4 py-3 shadow-lg backdrop-blur-md transition-all ${style.cls} ${entered ? 'translate-x-0 opacity-100' : 'translate-x-4 opacity-0'}`}
    >
      <span
        className={`material-symbols-outlined mt-0.5 text-[20px] ${style.iconCls}`}
        style={{ fontVariationSettings: "'FILL' 1" }}
      >
        {style.icon}
      </span>
      <p className="flex-1 text-body-sm text-on-surface">{toast.message}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="text-[18px] leading-none text-on-surface-variant hover:text-on-surface"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
