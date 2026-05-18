import { type ProblemDetails } from '@claims/error-codes';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

// Default request timeout. The API targets <2s p95 on real workloads; 30s
// leaves comfortable headroom for first-paint hydration, slow LAN egress,
// and the heavy /admin/audit query under load — and still bounds the
// "forever spinner" failure mode that ate demos before this landed.
//
// Callers can override per-request via `RequestOptions.timeoutMs`. Set
// to 0 to disable (e.g. long-poll endpoints), or pass an explicit
// AbortSignal to cancel from React's useEffect cleanup.
const DEFAULT_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
  constructor(public readonly problem: ProblemDetails) {
    super(problem.title);
    this.name = 'ApiError';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /**
   * Per-request timeout in milliseconds. Defaults to 30_000.
   * Set to 0 to disable the timeout (long-poll / SSE endpoints).
   */
  timeoutMs?: number;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = `${API_URL}${path}`;
  const init: RequestInit = {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...options.headers,
    },
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  const composed = combineSignals(options.signal, timeoutSignal);
  if (composed) init.signal = composed;

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // AbortSignal.timeout throws DOMException with name 'TimeoutError'.
    // User-driven AbortController.abort() throws name 'AbortError'. Both
    // collapse to the same UX outcome ("nothing came back") but only
    // the timeout deserves a modal — user-driven aborts are usually
    // route changes and should bubble untouched.
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new ApiError({
        type: 'urn:claims:error:REQUEST_TIMEOUT',
        title: 'Request timed out',
        status: 504,
        code: 'INTERNAL_ERROR',
        detail: `No response after ${timeoutMs}ms.`,
      });
    }
    throw err;
  }

  if (!res.ok) {
    let problem: ProblemDetails;
    try {
      problem = (await res.json()) as ProblemDetails;
    } catch {
      problem = {
        type: 'urn:claims:error:INTERNAL_ERROR',
        title: 'Unexpected error',
        status: res.status,
        code: 'INTERNAL_ERROR',
      };
    }
    throw new ApiError(problem);
  }
  if (res.status === 204) {
    return undefined as unknown as T;
  }
  return (await res.json()) as T;
}

// Merge an optional caller-supplied signal with the per-request timeout
// signal so either source can abort the fetch. Prefers AbortSignal.any
// (modern browsers + Node 20+); falls back to a manual relay when the
// runtime is older. Returns undefined when both inputs are absent so we
// don't add a no-op signal to RequestInit.
function combineSignals(
  caller: AbortSignal | undefined,
  timeout: AbortSignal | undefined,
): AbortSignal | undefined {
  const real = [caller, timeout].filter((s): s is AbortSignal => Boolean(s));
  if (real.length === 0) return undefined;
  if (real.length === 1) return real[0];
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn(real);
  const ctrl = new AbortController();
  for (const s of real) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}
