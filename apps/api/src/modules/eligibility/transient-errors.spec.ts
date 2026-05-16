// T1-5 — Classifier unit tests. Cover the patterns the JWE adapter
// actually emits (HTTP 5xx, fetch AbortError, undici socket
// errors) plus a few negative-case clean-fail examples.

import { classifyAdapterError } from './transient-errors';

describe('classifyAdapterError', () => {
  it.each([
    ['NHCX coverageeligibility/check failed with HTTP 502', 'transient', 'server_5xx'],
    ['NHCX preauth/submit failed with HTTP 503', 'transient', 'server_5xx'],
    ['fetch failed: ECONNRESET', 'transient', 'network'],
    ['getaddrinfo ENOTFOUND nhcx.sandbox.io', 'transient', 'network'],
    ['Request aborted: timeout 30000ms', 'transient', 'timeout'],
    ['The operation timed out', 'transient', 'timeout'],
    ['socket hang up', 'transient', 'network'],
  ])('classifies %p as transient (%s)', (msg, expectedClassification, expectedClass) => {
    const out = classifyAdapterError(new Error(msg));
    expect(out.classification).toBe(expectedClassification);
    expect(out.failureClass).toBe(expectedClass);
  });

  it.each([
    ['NHCX coverageeligibility/check failed with HTTP 400', 'permanent', 'validation'],
    ['NHCX preauth/submit failed with HTTP 401', 'permanent', 'auth'],
    ['JWE decrypt failed: no matching private key', 'permanent', 'unknown'],
    ['Forbidden — sender not in allowlist', 'permanent', 'auth'],
  ])('classifies %p as permanent (%s)', (msg, expectedClassification, expectedClass) => {
    const out = classifyAdapterError(new Error(msg));
    expect(out.classification).toBe(expectedClassification);
    expect(out.failureClass).toBe(expectedClass);
  });

  it('treats unknown error messages as permanent (conservative)', () => {
    const out = classifyAdapterError(new Error('something went sideways'));
    expect(out.classification).toBe('permanent');
    expect(out.failureClass).toBe('unknown');
  });

  it('handles non-Error throws by stringifying', () => {
    const out = classifyAdapterError('HTTP 502 Bad Gateway');
    expect(out.classification).toBe('transient');
    expect(out.failureClass).toBe('server_5xx');
  });
});
