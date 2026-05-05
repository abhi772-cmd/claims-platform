// Slice P3 integration test — HprRealAdapter end-to-end against an
// in-process mock ABDM server. We script three endpoints:
//   POST /gateway/v0.5/sessions                    → access token
//   POST /api/v1/auth/init                         → txnId
//   POST /api/v1/auth/confirmWithMobileOTP         → x-token
//   GET  /api/v2/hpr/healthcareprofessional/:hprId → profile
//
// Each test verifies a different leg of the flow without needing a real
// ABDM Sandbox account.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { type ConfigService } from '@nestjs/config';

import { HprVerificationFailedError } from '../../src/common/errors/auth-errors';
import { HprRealAdapter } from '../../src/modules/hpr/hpr-real.adapter';

jest.setTimeout(60_000);

interface MockAbdm {
  url: string;
  shutdown: () => Promise<void>;
  // Expose received bodies so tests can assert what we sent.
  received: Map<string, unknown[]>;
}

interface MockResponse {
  status?: number;
  body: unknown;
}

interface RoutesByPath {
  [path: string]: (body: unknown) => MockResponse;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function startMockAbdm(routes: RoutesByPath): Promise<MockAbdm> {
  const received = new Map<string, unknown[]>();
  const server: Server = createServer(async (req, res) => {
    const path = req.url ?? '/';
    const handler = routes[path] ?? routes[matchPrefix(path, routes)];
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `no mock for ${req.method} ${path}` }));
      return;
    }
    const body = await readBody(req);
    const list = received.get(path) ?? [];
    list.push(body);
    received.set(path, list);
    const out = handler(body);
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    shutdown: () => new Promise((resolve) => server.close(() => resolve())),
    received,
  };
}

// Match /api/v2/hpr/healthcareprofessional/{hprId} with a single
// catch-all entry (the path varies by hprId).
function matchPrefix(path: string, routes: RoutesByPath): string {
  for (const key of Object.keys(routes)) {
    if (key.endsWith('*') && path.startsWith(key.slice(0, -1))) return key;
  }
  return '';
}

const cfg = (values: Record<string, unknown>): ConfigService =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

const buildAdapter = (url: string): HprRealAdapter =>
  new HprRealAdapter(
    cfg({
      ABDM_BASE_URL: url,
      ABDM_CLIENT_ID: 'test-client',
      ABDM_CLIENT_SECRET: 'test-secret',
      ABDM_HTTP_TIMEOUT_MS: 5000,
    }) as never,
  );

describe('Slice P3 — HprRealAdapter against mock ABDM', () => {
  let mock: MockAbdm | undefined;

  afterEach(async () => {
    if (mock) {
      await mock.shutdown();
      mock = undefined;
    }
  });

  it('requestOtp: fetches access token then calls /auth/init', async () => {
    mock = await startMockAbdm({
      '/gateway/v0.5/sessions': () => ({ body: { accessToken: 'TOK-1', expiresIn: 1800 } }),
      '/api/v1/auth/init': (body) => {
        expect((body as { id: string }).id).toBe('12345678901234');
        return { body: { txnId: 'TXN-ABC' } };
      },
    });
    const adapter = buildAdapter(mock.url);
    const out = await adapter.requestOtp('12345678901234');
    expect(out.transactionId).toBe('TXN-ABC');
    expect(new Date(out.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Sanity: the init body has the right authMethod.
    const initCalls = mock.received.get('/api/v1/auth/init') ?? [];
    expect(initCalls).toHaveLength(1);
    expect((initCalls[0] as { authMethod: string }).authMethod).toBe('MOBILE_OTP');
  });

  it('verifyOtp: confirm + profile lookup returns the doctor profile', async () => {
    mock = await startMockAbdm({
      '/gateway/v0.5/sessions': () => ({ body: { accessToken: 'TOK-2' } }),
      '/api/v1/auth/confirmWithMobileOTP': (body) => {
        const b = body as { otp: string; txnId: string };
        expect(b.otp).toBe('123456');
        expect(b.txnId).toBe('TXN-XYZ');
        return { body: { token: 'XTOK-9' } };
      },
      '/api/v2/hpr/healthcareprofessional/*': () => ({
        body: {
          hprId: '12345678901234',
          firstName: 'Asha',
          lastName: 'Iyer',
          registrationStatus: 'Active',
        },
      }),
    });
    const adapter = buildAdapter(mock.url);
    const out = await adapter.verifyOtp({
      hprId: '12345678901234',
      otp: '123456',
      transactionId: 'TXN-XYZ',
    });
    expect(out.hprId).toBe('12345678901234');
    expect(out.fullName).toBe('Asha Iyer');
    expect(out.registrationActive).toBe(true);
  });

  it('verifyOtp without transactionId is rejected without HTTP calls', async () => {
    mock = await startMockAbdm({
      '/gateway/v0.5/sessions': () => ({ body: { accessToken: 'TOK-3' } }),
    });
    const adapter = buildAdapter(mock.url);
    await expect(
      adapter.verifyOtp({ hprId: '12345678901234', otp: '123456' }),
    ).rejects.toBeInstanceOf(HprVerificationFailedError);
    // Token endpoint never called — short-circuit.
    expect(mock.received.get('/gateway/v0.5/sessions') ?? []).toHaveLength(0);
  });

  it('verifyOtp surfaces ABDM 401 on confirm as HprVerificationFailedError', async () => {
    mock = await startMockAbdm({
      '/gateway/v0.5/sessions': () => ({ body: { accessToken: 'TOK-4' } }),
      '/api/v1/auth/confirmWithMobileOTP': () => ({
        status: 401,
        body: { error: 'invalid OTP' },
      }),
    });
    const adapter = buildAdapter(mock.url);
    await expect(
      adapter.verifyOtp({
        hprId: '12345678901234',
        otp: '000000',
        transactionId: 'TXN-BAD',
      }),
    ).rejects.toBeInstanceOf(HprVerificationFailedError);
  });

  it('verifyOtp marks registrationActive=false when profile says Suspended', async () => {
    mock = await startMockAbdm({
      '/gateway/v0.5/sessions': () => ({ body: { accessToken: 'TOK-5' } }),
      '/api/v1/auth/confirmWithMobileOTP': () => ({ body: { token: 'XTOK-S' } }),
      '/api/v2/hpr/healthcareprofessional/*': () => ({
        body: {
          hprId: '12345678901234',
          fullName: 'Dr. Inactive',
          registrationStatus: 'Suspended',
        },
      }),
    });
    const adapter = buildAdapter(mock.url);
    const out = await adapter.verifyOtp({
      hprId: '12345678901234',
      otp: '123456',
      transactionId: 'TXN-SUSP',
    });
    expect(out.registrationActive).toBe(false);
  });
});
