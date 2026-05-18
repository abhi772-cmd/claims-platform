import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { type AppConfig } from '../../config/configuration';

interface CachedToken {
  token: string;
  // Absolute expiry instant in epoch ms. The cache returns the token
  // while now < refreshAt; once we cross refreshAt we mint a new one.
  refreshAt: number;
}

interface SessionTokenWire {
  // NHCX session-token responses vary slightly across sandboxes; we
  // accept any of these shapes and surface them through one cache.
  access_token?: string;
  accessToken?: string;
  token?: string;
  expires_in?: number;
  expiresIn?: number;
  // Some sandboxes return an absolute epoch-seconds expiry instead.
  expires_at?: number;
  expiresAt?: number;
}

// Default TTL when the gateway omits expires_in. The NHCX docs quote
// 5 minutes; we pick the same so we don't sit on a stale token for
// hours when an unfamiliar response shape lands.
const DEFAULT_TOKEN_TTL_SECONDS = 300;

/**
 * Mints + caches NHCX `Authorization: Bearer <token>` for every outbound
 * protocol call. Single instance per process — concurrent callers share
 * a single in-flight mint and a single cached token. Callers signal a
 * 401 by calling {@link forceRefresh} before retrying.
 *
 * Stub-mode deployments resolve {@link bearerToken} to `null` — the
 * outbound adapter omits the header in that case (the stub gateway
 * never checks it).
 */
@Injectable()
export class NhcxSessionTokenService {
  private readonly log = new Logger(NhcxSessionTokenService.name);

  private cached: CachedToken | null = null;
  // Coalesce concurrent mints so two callers don't both POST credentials
  // when the cache is cold. The promise resolves to the new cached row
  // (or null in stub mode).
  private inflight: Promise<CachedToken | null> | null = null;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  /**
   * Returns a fresh-enough bearer token, refreshing transparently if
   * the cached one is past its safety margin. Returns null when the
   * adapter is in stub-mode (caller should omit the header entirely).
   */
  async getBearer(): Promise<string | null> {
    if (this.config.get('NHCX_MODE', { infer: true }) !== 'real') return null;
    // P0.1 — session-token envs are mandatory in production
    // (configuration.ts enforces this at boot) but the
    // integration-test callback rigs run NHCX_MODE=real against an
    // in-process mock gateway that doesn't check Authorization.
    // When the envs are absent we skip the mint and let the adapter
    // omit the header — same shape as stub mode.
    const tokenUrl = this.config.get('NHCX_SESSION_TOKEN_URL', { infer: true });
    const clientId = this.config.get('NHCX_CLIENT_ID', { infer: true });
    const clientSecret = this.config.get('NHCX_CLIENT_SECRET', { infer: true });
    if (!tokenUrl || !clientId || !clientSecret) return null;

    const now = Date.now();
    if (this.cached && now < this.cached.refreshAt) return this.cached.token;

    const row = await this.mint();
    return row?.token ?? null;
  }

  /**
   * Drops the cached token. Callers MUST hit this on 401 before
   * retrying — otherwise the next call would just replay the
   * already-invalidated token from the cache.
   */
  forceRefresh(): void {
    this.cached = null;
  }

  // -------------- internals --------------------------------------

  private async mint(): Promise<CachedToken | null> {
    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      try {
        const tokenUrl = this.config.get('NHCX_SESSION_TOKEN_URL', { infer: true });
        const clientId = this.config.get('NHCX_CLIENT_ID', { infer: true });
        const clientSecret = this.config.get('NHCX_CLIENT_SECRET', { infer: true });
        const timeoutMs = this.config.get('NHCX_HTTP_TIMEOUT_MS', { infer: true });
        const leadSeconds = this.config.get('NHCX_SESSION_TOKEN_REFRESH_LEAD_SECONDS', {
          infer: true,
        });

        // The config loader rejects real-mode without these — runtime
        // is defense-in-depth in case the service is wired before
        // config validation (e.g. in a manually-constructed test).
        if (!tokenUrl || !clientId || !clientSecret) {
          throw new Error(
            'NHCX session-token config missing — should have been caught by config loader.',
          );
        }

        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        const startedAt = Date.now();
        let res: Response;
        try {
          res = await fetch(tokenUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              accept: 'application/json',
            },
            body: new URLSearchParams({
              grant_type: 'client_credentials',
              client_id: clientId,
              client_secret: clientSecret,
            }).toString(),
            signal: ac.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        const latencyMs = Date.now() - startedAt;

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          this.log.warn(
            `nhcx session-token mint HTTP ${res.status} (${latencyMs}ms) body=${body.slice(0, 200)}`,
          );
          throw new Error(`NHCX session-token mint failed with HTTP ${res.status}`);
        }

        const wire = (await res.json()) as SessionTokenWire;
        const token = wire.access_token ?? wire.accessToken ?? wire.token;
        if (!token) {
          throw new Error('NHCX session-token response had no access_token field');
        }

        const ttlSeconds = wire.expires_in ?? wire.expiresIn ?? DEFAULT_TOKEN_TTL_SECONDS;
        const expiresAtMs =
          wire.expires_at !== undefined
            ? wire.expires_at * 1000
            : wire.expiresAt !== undefined
              ? wire.expiresAt * 1000
              : Date.now() + ttlSeconds * 1000;
        // Subtract the lead margin so we mint a fresh token before
        // the in-flight outbound call hits an expired one.
        const refreshAt = Math.max(Date.now() + 1000, expiresAtMs - leadSeconds * 1000);

        const row: CachedToken = { token, refreshAt };
        this.cached = row;
        this.log.log(
          `nhcx session-token minted ok (${latencyMs}ms) refreshIn=${Math.round((refreshAt - Date.now()) / 1000)}s`,
        );
        return row;
      } finally {
        this.inflight = null;
      }
    })();

    return this.inflight;
  }
}
