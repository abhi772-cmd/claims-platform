import { type ConfigService } from '@nestjs/config';

import { type AppConfig } from '../../config/configuration';
import { NhcxSessionTokenService } from './nhcx-session-token.service';

interface ConfigShape {
  NHCX_MODE?: 'real' | 'stub';
  NHCX_SESSION_TOKEN_URL?: string;
  NHCX_CLIENT_ID?: string;
  NHCX_CLIENT_SECRET?: string;
  NHCX_HTTP_TIMEOUT_MS?: number;
  NHCX_SESSION_TOKEN_REFRESH_LEAD_SECONDS?: number;
}

function makeService(overrides: ConfigShape = {}): NhcxSessionTokenService {
  const config: ConfigShape = {
    NHCX_MODE: 'real',
    NHCX_SESSION_TOKEN_URL: 'https://example.test/session',
    NHCX_CLIENT_ID: 'cid',
    NHCX_CLIENT_SECRET: 'csec',
    NHCX_HTTP_TIMEOUT_MS: 5_000,
    NHCX_SESSION_TOKEN_REFRESH_LEAD_SECONDS: 30,
    ...overrides,
  };
  const cfg = {
    get<K extends keyof ConfigShape>(key: K): ConfigShape[K] {
      return config[key];
    },
  } as unknown as ConfigService<AppConfig, true>;
  return new NhcxSessionTokenService(cfg);
}

describe('NhcxSessionTokenService', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns null in stub mode without ever touching the network', async () => {
    let calls = 0;
    globalThis.fetch = ((..._args: unknown[]) => {
      calls += 1;
      return Promise.resolve(new Response('', { status: 200 }));
    }) as typeof globalThis.fetch;
    const svc = makeService({ NHCX_MODE: 'stub' });
    expect(await svc.getBearer()).toBeNull();
    expect(calls).toBe(0);
  });

  it('mints a fresh token in real mode and caches it for subsequent calls', async () => {
    let calls = 0;
    globalThis.fetch = ((..._args: unknown[]) => {
      calls += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: 'AAA', expires_in: 600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch;

    const svc = makeService();
    expect(await svc.getBearer()).toBe('AAA');
    expect(await svc.getBearer()).toBe('AAA');
    expect(calls).toBe(1);
  });

  it('re-mints after forceRefresh()', async () => {
    let calls = 0;
    globalThis.fetch = ((..._args: unknown[]) => {
      calls += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: `tok-${calls}`, expires_in: 600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch;

    const svc = makeService();
    expect(await svc.getBearer()).toBe('tok-1');
    svc.forceRefresh();
    expect(await svc.getBearer()).toBe('tok-2');
    expect(calls).toBe(2);
  });

  it('coalesces concurrent mints into a single network call', async () => {
    let calls = 0;
    let resolveFetch: (resp: Response) => void = () => {};
    globalThis.fetch = ((..._args: unknown[]) => {
      calls += 1;
      return new Promise<Response>((res) => {
        resolveFetch = res;
      });
    }) as typeof globalThis.fetch;

    const svc = makeService();
    const [p1, p2, p3] = [svc.getBearer(), svc.getBearer(), svc.getBearer()];
    resolveFetch(
      new Response(JSON.stringify({ access_token: 'BBB', expires_in: 600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const [t1, t2, t3] = await Promise.all([p1, p2, p3]);
    expect([t1, t2, t3]).toEqual(['BBB', 'BBB', 'BBB']);
    expect(calls).toBe(1);
  });

  it('uses default 5-minute TTL when expires_in is absent', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ access_token: 'CCC' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof globalThis.fetch;
    const svc = makeService();
    expect(await svc.getBearer()).toBe('CCC');
  });

  it('throws when the upstream returns non-2xx', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response('forbidden', { status: 403 }))) as typeof globalThis.fetch;
    const svc = makeService();
    await expect(svc.getBearer()).rejects.toThrow(/HTTP 403/);
  });

  it('throws when the response body lacks an access_token field', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ wrong: 'shape' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof globalThis.fetch;
    const svc = makeService();
    await expect(svc.getBearer()).rejects.toThrow(/no access_token/);
  });
});
