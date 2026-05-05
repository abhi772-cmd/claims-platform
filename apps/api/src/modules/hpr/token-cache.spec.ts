import { TokenCache } from './token-cache';

describe('TokenCache', () => {
  it('caches the token across get() calls (only one mint)', async () => {
    const cache = new TokenCache();
    let mints = 0;
    const fetcher = async (): Promise<{ token: string; ttlSeconds: number }> => {
      mints += 1;
      return { token: `tok-${mints}`, ttlSeconds: 1800 };
    };
    const a = await cache.get('k', fetcher);
    const b = await cache.get('k', fetcher);
    const c = await cache.get('k', fetcher);
    expect(a).toBe('tok-1');
    expect(b).toBe('tok-1');
    expect(c).toBe('tok-1');
    expect(mints).toBe(1);
  });

  it('refreshes when the entry expires', async () => {
    const cache = new TokenCache();
    let mints = 0;
    // The safety margin clamps the effective TTL to a 1-second floor,
    // so the smallest expiry we can drive in real time is ~1s. Wait
    // 1.1s past the first mint and the next get() must re-fetch.
    const fetcher = async (): Promise<{ token: string; ttlSeconds: number }> => {
      mints += 1;
      return { token: `tok-${mints}`, ttlSeconds: 0 };
    };
    await cache.get('k', fetcher);
    await new Promise((r) => setTimeout(r, 1100));
    await cache.get('k', fetcher);
    expect(mints).toBe(2);
  });

  it('invalidate() forces a fresh mint on next get()', async () => {
    const cache = new TokenCache();
    let mints = 0;
    const fetcher = async (): Promise<{ token: string; ttlSeconds: number }> => {
      mints += 1;
      return { token: `tok-${mints}`, ttlSeconds: 1800 };
    };
    await cache.get('k', fetcher);
    cache.invalidate('k');
    await cache.get('k', fetcher);
    expect(mints).toBe(2);
  });

  it('keeps separate entries per key', async () => {
    const cache = new TokenCache();
    const a = await cache.get('a', async () => ({ token: 'A', ttlSeconds: 1800 }));
    const b = await cache.get('b', async () => ({ token: 'B', ttlSeconds: 1800 }));
    expect(a).toBe('A');
    expect(b).toBe('B');
    expect(cache.size()).toBe(2);
  });

  it('collapses concurrent misses for the same key into one fetch', async () => {
    const cache = new TokenCache();
    let inflight = 0;
    let peak = 0;
    let mints = 0;
    const fetcher = async (): Promise<{ token: string; ttlSeconds: number }> => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      // micro-yield to give the other awaiters a chance to interleave
      await new Promise((r) => setTimeout(r, 5));
      mints += 1;
      inflight -= 1;
      return { token: `tok-${mints}`, ttlSeconds: 1800 };
    };
    const results = await Promise.all([
      cache.get('k', fetcher),
      cache.get('k', fetcher),
      cache.get('k', fetcher),
    ]);
    expect(mints).toBe(1);
    expect(peak).toBe(1);
    expect(results).toEqual(['tok-1', 'tok-1', 'tok-1']);
  });
});
