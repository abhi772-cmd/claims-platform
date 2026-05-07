// Slice BF — unit coverage for HttpBiometricAuthAdapter against a
// node:http mock ABDM server. Captures the request shape (method,
// path, headers, JSON body) and returns canned responses that mirror
// the documented ABDM contract.

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { type AddressInfo } from 'node:net';

import { type ConfigService } from '@nestjs/config';

import {
  type BiometricInitInput,
  type BiometricRefreshInput,
  type BiometricVerifyInput,
} from './biometric-auth-adapter.interface';
import { HttpBiometricAuthAdapter } from './http-biometric-auth.adapter';
import { type AppConfig } from '../../config/configuration';

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body: string;
}

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

async function startMock(
  handler: Handler,
): Promise<{ baseUrl: string; captured: CapturedRequest[]; close: () => Promise<void> }> {
  const captured: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      captured.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers as Record<string, string | undefined>,
        body,
      });
      handler(req, res, body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        captured,
        close: () =>
          new Promise<void>((res) => {
            server.closeAllConnections();
            server.close(() => res());
          }),
      });
    });
  });
}

function makeAdapter(opts: {
  baseUrl?: string | undefined;
  timeoutMs?: number;
}): HttpBiometricAuthAdapter {
  const config = {
    get(key: string): unknown {
      if (key === 'BIOMETRIC_AUTH_BASE_URL') return opts.baseUrl;
      if (key === 'BIOMETRIC_AUTH_HTTP_TIMEOUT_MS') return opts.timeoutMs ?? 15_000;
      return undefined;
    },
  } as unknown as ConfigService<AppConfig, true>;
  return new HttpBiometricAuthAdapter(config);
}

const baseInit: BiometricInitInput = {
  scope: 'aadhaar-bio-verify',
  loginHint: 'abha-number',
  loginId: '91-1234-5678-0001',
  authMode: 'FINGERPRINT',
  process: 'Preauth',
  payerId: '123@hcx',
  bearerToken: 'platform-jwt',
};

describe('HttpBiometricAuthAdapter', () => {
  it('returns failed when BIOMETRIC_AUTH_BASE_URL is missing', async () => {
    const a = makeAdapter({});
    const r = await a.init(baseInit);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/BIOMETRIC_AUTH_BASE_URL/);
  });

  it('init posts the documented body + headers, parses txnId', async () => {
    const mock = await startMock((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ txnId: 'abdm-txn-001' }));
    });
    try {
      const a = makeAdapter({ baseUrl: mock.baseUrl });
      const r = await a.init(baseInit);
      expect(r.status).toBe('init_ok');
      expect(r.txnId).toBe('abdm-txn-001');
      expect(mock.captured).toHaveLength(1);
      const c = mock.captured[0]!;
      expect(c.method).toBe('POST');
      expect(c.url).toBe('/hcx/abha/biometric/auth/init');
      expect(c.headers['authorization']).toBe('Bearer platform-jwt');
      expect(c.headers['process']).toBe('Preauth');
      expect(c.headers['payerid']).toBe('123@hcx');
      expect(c.headers['content-type']).toMatch(/application\/json/);
      const parsed = JSON.parse(c.body) as Record<string, unknown>;
      expect(parsed['scope']).toEqual(['abha-login', 'aadhaar-bio-verify']);
      expect(parsed['loginHint']).toBe('abha-number');
      expect(parsed['loginId']).toBe('91-1234-5678-0001');
      expect(parsed['authMode']).toBe('FINGERPRINT');
      expect(parsed['otpSystem']).toBe('aadhaar');
    } finally {
      await mock.close();
    }
  });

  it('init → failed when ABDM returns no txnId', async () => {
    const mock = await startMock((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: 'no txn here' }));
    });
    try {
      const a = makeAdapter({ baseUrl: mock.baseUrl });
      const r = await a.init(baseInit);
      expect(r.status).toBe('failed');
      expect(r.error).toMatch(/did not include a txnId/);
    } finally {
      await mock.close();
    }
  });

  it('init → failed on HTTP 401 (auth rejected)', async () => {
    const mock = await startMock((_req, res) => {
      res.statusCode = 401;
      res.end('Unauthorized');
    });
    try {
      const a = makeAdapter({ baseUrl: mock.baseUrl });
      const r = await a.init(baseInit);
      expect(r.status).toBe('failed');
      expect(r.error).toMatch(/HTTP 401/);
    } finally {
      await mock.close();
    }
  });

  it('verify FINGERPRINT posts authData.bio with the PID', async () => {
    const mock = await startMock((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ token: 'abha-token-001', refreshToken: 'rt-001' }));
    });
    try {
      const a = makeAdapter({ baseUrl: mock.baseUrl });
      const input: BiometricVerifyInput = {
        scope: 'aadhaar-bio-verify',
        authMode: 'FINGERPRINT',
        authData: { txnId: 'abdm-txn-001', fingerPrintAuthPid: 'PID-BLOB-AAA' },
        process: 'Preauth',
        payerId: '123@hcx',
        bearerToken: 'platform-jwt',
      };
      const r = await a.verify(input);
      expect(r.status).toBe('verified');
      expect(r.authToken).toBe('abha-token-001');
      expect(r.refreshToken).toBe('rt-001');
      const c = mock.captured[0]!;
      expect(c.url).toBe('/hcx/abha/biometric/auth/verify');
      const parsed = JSON.parse(c.body) as Record<string, unknown>;
      expect(parsed['scope']).toEqual(['abha-login', 'aadhaar-bio-verify']);
      const ad = parsed['authData'] as Record<string, unknown>;
      expect(ad['authMethods']).toEqual(['bio']);
      expect(ad['bio']).toEqual({ txnId: 'abdm-txn-001', fingerPrintAuthPid: 'PID-BLOB-AAA' });
      expect(ad['face']).toBeUndefined();
      expect(ad['iris']).toBeUndefined();
    } finally {
      await mock.close();
    }
  });

  it('verify FACE_AUTH posts authData.face only', async () => {
    const mock = await startMock((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ token: 'abha-token-face' }));
    });
    try {
      const a = makeAdapter({ baseUrl: mock.baseUrl });
      const input: BiometricVerifyInput = {
        scope: 'aadhaar-face-verify',
        authMode: 'FACE_AUTH',
        authData: { txnId: 'abdm-txn-002', faceAuthPid: 'PID-FACE' },
        process: 'Discharge',
        payerId: '123@hcx',
        bearerToken: 'platform-jwt',
      };
      const r = await a.verify(input);
      expect(r.status).toBe('verified');
      const ad = JSON.parse(mock.captured[0]!.body)['authData'] as Record<string, unknown>;
      expect(ad['authMethods']).toEqual(['face']);
      expect(ad['face']).toEqual({ txnId: 'abdm-txn-002', faceAuthPid: 'PID-FACE' });
      expect(ad['bio']).toBeUndefined();
      expect(ad['iris']).toBeUndefined();
      expect(mock.captured[0]!.headers['process']).toBe('Discharge');
    } finally {
      await mock.close();
    }
  });

  it('verify IRIS posts authData.iris only', async () => {
    const mock = await startMock((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ token: 'abha-token-iris' }));
    });
    try {
      const a = makeAdapter({ baseUrl: mock.baseUrl });
      const r = await a.verify({
        scope: 'aadhaar-iris-verify',
        authMode: 'IRIS',
        authData: { txnId: 'abdm-txn-003', irisAuthPid: 'PID-IRIS' },
        process: 'Preauth',
        payerId: '123@hcx',
        bearerToken: 'platform-jwt',
      });
      expect(r.status).toBe('verified');
      const ad = JSON.parse(mock.captured[0]!.body)['authData'] as Record<string, unknown>;
      expect(ad['authMethods']).toEqual(['iris']);
      expect(ad['iris']).toEqual({ txnId: 'abdm-txn-003', irisAuthPid: 'PID-IRIS' });
    } finally {
      await mock.close();
    }
  });

  it('verify → failed when ABDM omits the token', async () => {
    const mock = await startMock((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ refreshToken: 'rt-but-no-token' }));
    });
    try {
      const a = makeAdapter({ baseUrl: mock.baseUrl });
      const r = await a.verify({
        scope: 'aadhaar-bio-verify',
        authMode: 'FINGERPRINT',
        authData: { txnId: 'x', fingerPrintAuthPid: 'p' },
        process: 'Preauth',
        payerId: '123@hcx',
        bearerToken: 'platform-jwt',
      });
      expect(r.status).toBe('failed');
      expect(r.error).toMatch(/did not include a token/);
    } finally {
      await mock.close();
    }
  });

  it('refreshToken GETs the refresh endpoint with R-token header', async () => {
    const mock = await startMock((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ token: 'abha-token-refreshed' }));
    });
    try {
      const a = makeAdapter({ baseUrl: mock.baseUrl });
      const input: BiometricRefreshInput = {
        bearerToken: 'platform-jwt',
        refreshToken: 'rt-001',
        process: 'Discharge',
        payerId: '123@hcx',
      };
      const r = await a.refreshToken(input);
      expect(r.status).toBe('refreshed');
      expect(r.authToken).toBe('abha-token-refreshed');
      const c = mock.captured[0]!;
      expect(c.method).toBe('GET');
      expect(c.url).toBe('/hcx/abha/biometric/auth/refresh/token');
      expect(c.headers['authorization']).toBe('Bearer platform-jwt');
      expect(c.headers['r-token']).toBe('Bearer rt-001');
      expect(c.headers['process']).toBe('Discharge');
      expect(c.headers['payerid']).toBe('123@hcx');
    } finally {
      await mock.close();
    }
  });

  it('refreshToken → failed when ABDM returns 5xx', async () => {
    const mock = await startMock((_req, res) => {
      res.statusCode = 500;
      res.end('Internal Server Error');
    });
    try {
      const a = makeAdapter({ baseUrl: mock.baseUrl });
      const r = await a.refreshToken({
        bearerToken: 'platform-jwt',
        refreshToken: 'rt-001',
        process: 'Discharge',
        payerId: '123@hcx',
      });
      expect(r.status).toBe('failed');
      expect(r.error).toMatch(/HTTP 500/);
    } finally {
      await mock.close();
    }
  });

  it('init → failed on connection refused (network error)', async () => {
    const a = makeAdapter({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2_000 });
    const r = await a.init(baseInit);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/HTTP call failed/);
  });
});
