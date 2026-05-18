import { NhcxProcessingIdCacheService } from './nhcx-processing-id-cache.service';

describe('NhcxProcessingIdCacheService', () => {
  it('returns null on cache miss', () => {
    const c = new NhcxProcessingIdCacheService();
    expect(c.lookup('t-1', 'abha', '91-1234-5678-9999')).toBeNull();
  });

  it('returns the cached processingId after remember()', () => {
    const c = new NhcxProcessingIdCacheService();
    c.remember('t-1', 'abha', '91-1234-5678-9999', 'PID-abc');
    expect(c.lookup('t-1', 'abha', '91-1234-5678-9999')).toBe('PID-abc');
  });

  it('treats different tenants as different cache scopes', () => {
    const c = new NhcxProcessingIdCacheService();
    c.remember('t-1', 'abha', '91-1234', 'PID-a');
    expect(c.lookup('t-2', 'abha', '91-1234')).toBeNull();
  });

  it('treats different identifier types as different cache scopes', () => {
    const c = new NhcxProcessingIdCacheService();
    c.remember('t-1', 'abha', '91-1234', 'PID-a');
    expect(c.lookup('t-1', 'mobile', '91-1234')).toBeNull();
  });

  it('expires entries past their TTL', () => {
    const c = new NhcxProcessingIdCacheService();
    c.remember('t-1', 'abha', '91-1234', 'PID-a', 10); // 10ms
    expect(c.lookup('t-1', 'abha', '91-1234')).toBe('PID-a');
    const originalNow = Date.now;
    try {
      const future = originalNow() + 1_000_000;
      Date.now = (): number => future;
      expect(c.lookup('t-1', 'abha', '91-1234')).toBeNull();
    } finally {
      Date.now = originalNow;
    }
  });

  it('invalidate returns true on a hit and false on a miss', () => {
    const c = new NhcxProcessingIdCacheService();
    c.remember('t-1', 'abha', '91-1234', 'PID-a');
    expect(c.invalidate('t-1', 'abha', '91-1234')).toBe(true);
    expect(c.invalidate('t-1', 'abha', '91-1234')).toBe(false);
    expect(c.lookup('t-1', 'abha', '91-1234')).toBeNull();
  });

  it('remember() with the same key slides the expiry forward', () => {
    const c = new NhcxProcessingIdCacheService();
    c.remember('t-1', 'abha', '91-1234', 'PID-a', 1_000);
    c.remember('t-1', 'abha', '91-1234', 'PID-a', 1_000_000);
    expect(c.lookup('t-1', 'abha', '91-1234')).toBe('PID-a');
  });
});
