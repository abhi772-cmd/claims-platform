'use client';

import { AlertCircle, AlertTriangle, Info, ShieldAlert } from 'lucide-react';
import { useEffect } from 'react';

import { type ErrorCode, type ErrorPresentation, type ErrorSeverity } from './error-map';

interface ErrorModalProps {
  code: ErrorCode;
  presentation: ErrorPresentation;
  detail?: string;
  onDismiss: () => void;
}

const severityClass: Record<ErrorSeverity, string> = {
  info: 'text-info-700 bg-info-50',
  warning: 'text-warning-700 bg-warning-50',
  error: 'text-danger-700 bg-danger-50',
  critical: 'text-danger-700 bg-danger-50',
};

function SeverityIcon({ severity }: { severity: ErrorSeverity }): JSX.Element {
  switch (severity) {
    case 'info':
      return <Info className="h-5 w-5" aria-hidden />;
    case 'warning':
      return <AlertTriangle className="h-5 w-5" aria-hidden />;
    case 'critical':
      return <ShieldAlert className="h-5 w-5" aria-hidden />;
    default:
      return <AlertCircle className="h-5 w-5" aria-hidden />;
  }
}

export function ErrorModal({ code, presentation, detail, onDismiss }: ErrorModalProps): JSX.Element {
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onDismiss();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="error-modal-title"
      aria-describedby="error-modal-body"
      className="fixed inset-0 z-modal flex items-center justify-center bg-[var(--bg-overlay)] p-4"
    >
      <div className="w-full max-w-md rounded-md bg-neutral-0 shadow-lg">
        <div className={`flex items-center gap-3 rounded-t-md px-5 py-3 ${severityClass[presentation.severity]}`}>
          <SeverityIcon severity={presentation.severity} />
          <h2 id="error-modal-title" className="text-base font-semibold">
            {presentation.title}
          </h2>
        </div>
        <div className="space-y-2 px-5 py-4">
          <p id="error-modal-body" className="text-sm text-neutral-700">
            {detail ?? presentation.body}
          </p>
          <p className="text-xs text-neutral-400">Reference: {code}</p>
        </div>
        <div className="flex justify-end gap-2 border-t border-neutral-200 px-5 py-3">
          {presentation.secondaryAction ? (
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-sm px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100"
            >
              {presentation.secondaryAction}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onDismiss}
            autoFocus
            className="rounded-sm bg-primary-600 px-3 py-1.5 text-sm font-medium text-neutral-0 hover:bg-primary-700"
          >
            {presentation.primaryAction ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}
