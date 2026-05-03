'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { type ErrorCode, errorMap, type ErrorPresentation } from './error-map';
import { ApiError } from '../../../lib/api/client';
import { ErrorModal } from './ErrorModal';

interface ErrorModalState {
  code: ErrorCode;
  presentation: ErrorPresentation;
  detail?: string;
}

interface ErrorModalContextValue {
  showError: (code: ErrorCode, detail?: string) => void;
  showApiError: (err: unknown) => void;
  dismiss: () => void;
}

const ErrorModalContext = createContext<ErrorModalContextValue | null>(null);

export function ErrorModalProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<ErrorModalState | null>(null);

  const showError = useCallback((code: ErrorCode, detail?: string) => {
    const presentation = errorMap[code];
    setState(detail !== undefined ? { code, presentation, detail } : { code, presentation });
  }, []);

  const showApiError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError) {
        const code = err.problem.code as ErrorCode;
        const presentation = errorMap[code] ?? errorMap.INTERNAL_ERROR;
        setState(
          err.problem.detail !== undefined
            ? { code, presentation, detail: err.problem.detail }
            : { code, presentation },
        );
      } else {
        setState({ code: 'INTERNAL_ERROR', presentation: errorMap.INTERNAL_ERROR });
      }
    },
    [],
  );

  const dismiss = useCallback(() => setState(null), []);

  const value = useMemo<ErrorModalContextValue>(
    () => ({ showError, showApiError, dismiss }),
    [showError, showApiError, dismiss],
  );

  return (
    <ErrorModalContext.Provider value={value}>
      {children}
      {state ? (
        <ErrorModal
          code={state.code}
          presentation={state.presentation}
          detail={state.detail}
          onDismiss={dismiss}
        />
      ) : null}
    </ErrorModalContext.Provider>
  );
}

export function useErrorModal(): ErrorModalContextValue {
  const ctx = useContext(ErrorModalContext);
  if (!ctx) throw new Error('useErrorModal must be used within ErrorModalProvider');
  return ctx;
}
