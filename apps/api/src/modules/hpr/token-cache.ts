// Process-local cache for short-lived bearer tokens. ABDM gateway
// access tokens last ~30 minutes; without caching, every doctor-sign
// request would burn a full token round-trip and tighten our hot
// path by ~200ms.
//
// The cache is intentionally NOT cluster-wide. Multiple API replicas
// will each maintain their own copy — that's fine, each replica still
// only mints O(1 token / 30min) under steady load. A central Redis
// cache is overkill until throughput justifies the operational cost.
//
// Concurrency: the inner mutex collapses simultaneous misses for the
// same key into one in-flight fetch. Without it, a thundering-herd of
// requests during a token expiry would each fetch their own token
// and we'd spam the upstream gateway.

export interface TokenCacheEntry {
  token: string;
  // Wall-clock expiry timestamp (ms since epoch).
  expiresAt: number;
}

export interface TokenFetcher {
  (): Promise<{ token: string; ttlSeconds: number }>;
}

// Refresh tokens this many seconds before they actually expire. Hides
// clock skew between us + the upstream gateway and saves the rare
// "token valid here, expired there" round-trip.
const SAFETY_MARGIN_SEC = 30;

export class TokenCache {
  private entries = new Map<string, TokenCacheEntry>();
  private inflight = new Map<string, Promise<string>>();

  async get(key: string, fetcher: TokenFetcher): Promise<string> {
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.token;
    }
    return this.fetchInflight(key, fetcher);
  }

  // Drop the cached entry. Called by the adapter on a 401 from the
  // upstream — the token has been revoked or invalidated by ABDM and
  // we shouldn't reuse it. The next get() will mint a fresh one.
  invalidate(key: string): void {
    this.entries.delete(key);
  }

  // Test-only inspector — lets specs assert the cache hit/miss
  // behaviour without needing wall-clock fakes.
  size(): number {
    return this.entries.size;
  }

  private fetchInflight(key: string, fetcher: TokenFetcher): Promise<string> {
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = (async () => {
      try {
        const { token, ttlSeconds } = await fetcher();
        const expiresAt = Date.now() + Math.max(1, ttlSeconds - SAFETY_MARGIN_SEC) * 1000;
        this.entries.set(key, { token, expiresAt });
        return token;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}
