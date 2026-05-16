import { type IntegrationFailureClass } from '@claims/contracts';

// T1-5 — Classify adapter errors into transient (retry-worthy) vs
// permanent. Used by EligibilityService to decide between
// 'queued_for_retry' (worker will replay) and 'failed' (operator
// has to act).
//
// Transient cases worth queuing:
//   - Network errors / connection reset / DNS failure
//   - HTTP 5xx from gateway
//   - AbortController timeout (from the JWE adapter's fetch timeout)
//
// Permanent cases (no point retrying — operator must intervene):
//   - HTTP 4xx (validation, auth, malformed FHIR, unknown member id)
//   - JWE decrypt failures (key rotation needed)
//   - FHIR parse failures (gateway changed the response shape)

const TRANSIENT_PATTERNS: ReadonlyArray<RegExp> = [
  /HTTP 5\d\d/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /EAI_AGAIN/i,
  /ENOTFOUND/i,
  /aborted/i,
  /time(?:d|s)? ?out/i, // "timeout" / "timed out" / "timesout"
  /network/i,
  /socket hang up/i,
];

const PERMANENT_PATTERNS: ReadonlyArray<RegExp> = [
  /HTTP 4\d\d/i,
  /JWE/i,
  /decrypt/i,
  /invalid signature/i,
  /unauthor/i,
  /forbidden/i,
];

export interface ClassifiedError {
  classification: 'transient' | 'permanent';
  failureClass: IntegrationFailureClass;
  message: string;
}

export function classifyAdapterError(err: unknown): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err);

  // Permanent classifications dominate — a 4xx that happens to mention
  // "timeout" in its body would otherwise get mis-classified.
  for (const re of PERMANENT_PATTERNS) {
    if (re.test(message)) {
      const failureClass: IntegrationFailureClass = /HTTP 401|unauthor|forbidden/i.test(message)
        ? 'auth'
        : /HTTP 4\d\d/i.test(message)
          ? 'validation'
          : 'unknown';
      return { classification: 'permanent', failureClass, message };
    }
  }
  for (const re of TRANSIENT_PATTERNS) {
    if (re.test(message)) {
      const failureClass: IntegrationFailureClass = /time(?:d|s)? ?out|aborted/i.test(message)
        ? 'timeout'
        : /HTTP 5\d\d/i.test(message)
          ? 'server_5xx'
          : 'network';
      return { classification: 'transient', failureClass, message };
    }
  }
  // Unknown errors are conservatively treated as permanent — better
  // to alert ops than to loop on something we don't recognise.
  return { classification: 'permanent', failureClass: 'unknown', message };
}
