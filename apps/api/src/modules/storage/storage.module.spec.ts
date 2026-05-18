// Regression test for the audit critical: storage.module's s3Provider
// previously returned `null as unknown as S3StorageAdapter` in stub
// mode. A consumer that injected S3StorageAdapter directly would NPE on
// first method call with no useful error. The fix returns a fail-fast
// Proxy that throws a precise diagnostic on any property access while
// surviving Nest's wiring and symbol-based introspection.

import { S3StorageAdapter } from './s3-storage.adapter';
import { makeStubModeS3StorageAdapter } from './storage.module';

describe('makeStubModeS3StorageAdapter — stub-mode fail-fast', () => {
  it('returns an object (not null) so DI wiring at boot succeeds', () => {
    const proxy = makeStubModeS3StorageAdapter();
    expect(proxy).not.toBeNull();
    expect(typeof proxy).toBe('object');
  });

  it('throws a precise diagnostic when any method is accessed', () => {
    const proxy = makeStubModeS3StorageAdapter() as unknown as {
      presignUpload: () => unknown;
    };
    expect(() => proxy.presignUpload()).toThrow(/STORAGE_MODE=stub/);
    expect(() => proxy.presignUpload()).toThrow(/presignUpload/);
  });

  it('throws on arbitrary property reads, not just known methods', () => {
    const proxy = makeStubModeS3StorageAdapter() as unknown as { anyField: unknown };
    expect(() => proxy.anyField).toThrow(/STORAGE_MODE=stub/);
  });

  it('survives symbol-based introspection (logging, util.inspect, JSON.stringify)', () => {
    const proxy = makeStubModeS3StorageAdapter();
    // Symbol-keyed access must NOT throw — Node logging, Nest reflection,
    // and JSON.stringify all read symbol keys; throwing would crash the
    // bootstrap that the proxy is supposed to keep alive.
    expect(() => String(proxy)).not.toThrow();
    expect((proxy as unknown as Record<symbol, unknown>)[Symbol.toPrimitive]).toBeUndefined();
    expect((proxy as unknown as Record<symbol, unknown>)[Symbol.toStringTag]).toBeUndefined();
  });

  it('is assignable to the S3StorageAdapter type at the boundary', () => {
    // Compile-time only — if the proxy weren't typed as S3StorageAdapter,
    // this assignment would fail tsc and the test wouldn't compile.
    const proxy: S3StorageAdapter = makeStubModeS3StorageAdapter();
    expect(proxy).toBeDefined();
  });
});
