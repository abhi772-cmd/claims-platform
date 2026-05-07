// Slice AR — unit coverage for TextGuruSmsProvider. Stands up a tiny
// node:http mock server on a random port and asserts both directions
// of the exchange (request shape + reply handling). The provider uses
// the global fetch — no mocking required.

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { type AddressInfo } from 'node:net';

import { type ConfigService } from '@nestjs/config';

import { TextGuruSmsProvider } from './textguru-sms.provider';
import { type AppConfig } from '../../config/configuration';

interface CapturedRequest {
  method: string;
  url: string;
  authorization: string;
  contentType: string;
  body: string;
}

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

async function startMock(handler: Handler): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server: Server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => handler(req, res, body));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((res) => {
            // Force-drop any in-flight sockets (the timeout test
            // intentionally never replies, so server.close() alone
            // would block until the socket times out at the OS
            // level — leaks the worker process between tests).
            server.closeAllConnections();
            server.close(() => res());
          }),
      });
    });
  });
}

function makeProvider(opts: {
  baseUrl?: string | undefined;
  timeoutMs?: number;
}): TextGuruSmsProvider {
  const config = {
    get(key: string): string | number | undefined {
      if (key === 'TEXTGURU_BASE_URL') return opts.baseUrl;
      if (key === 'TEXTGURU_HTTP_TIMEOUT_MS') return opts.timeoutMs ?? 15_000;
      return undefined;
    },
  } as unknown as ConfigService<AppConfig, true>;
  return new TextGuruSmsProvider(config);
}

describe('TextGuruSmsProvider', () => {
  let mock: { baseUrl: string; close: () => Promise<void> } | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.close();
      mock = null;
    }
  });

  it('POSTs to /api/v1/sms/send with bearer auth + JSON body on success', async () => {
    let captured: CapturedRequest | null = null;
    mock = await startMock((req, res, body) => {
      captured = {
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: (req.headers['authorization'] as string | undefined) ?? '',
        contentType: (req.headers['content-type'] as string | undefined) ?? '',
        body,
      };
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'queued', id: 'tg-msg-1' }));
    });
    const provider = makeProvider({ baseUrl: mock.baseUrl });
    await provider.send({
      apiKey: 'tg-secret',
      senderId: 'TENANT-A',
      to: '+919812345678',
      text: 'Consent OTP: 1234',
    });
    expect(captured).not.toBeNull();
    expect(captured!.method).toBe('POST');
    expect(captured!.url).toBe('/api/v1/sms/send');
    expect(captured!.authorization).toBe('Bearer tg-secret');
    expect(captured!.contentType).toBe('application/json');
    const parsed = JSON.parse(captured!.body) as Record<string, unknown>;
    expect(parsed['to']).toBe('+919812345678');
    expect(parsed['message']).toBe('Consent OTP: 1234');
    expect(parsed['senderId']).toBe('TENANT-A');
  });

  it('omits senderId from the payload when null', async () => {
    let captured: string | null = null;
    mock = await startMock((_req, res, body) => {
      captured = body;
      res.statusCode = 202;
      res.end('');
    });
    const provider = makeProvider({ baseUrl: mock.baseUrl });
    await provider.send({
      apiKey: 'tg',
      senderId: null,
      to: '+919812345678',
      text: 'hi',
    });
    const parsed = JSON.parse(captured!) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('senderId');
  });

  it('non-2xx response → throws with status + body', async () => {
    mock = await startMock((_req, res) => {
      res.statusCode = 401;
      res.end('Invalid API key');
    });
    const provider = makeProvider({ baseUrl: mock.baseUrl });
    await expect(
      provider.send({ apiKey: 'wrong', senderId: null, to: '+1', text: 'x' }),
    ).rejects.toThrow(/HTTP 401.*Invalid API key/);
  });

  it('5xx response → throws (treated as transient by upstream retry)', async () => {
    mock = await startMock((_req, res) => {
      res.statusCode = 503;
      res.end('Gateway temporarily unavailable');
    });
    const provider = makeProvider({ baseUrl: mock.baseUrl });
    await expect(
      provider.send({ apiKey: 'tg', senderId: null, to: '+1', text: 'x' }),
    ).rejects.toThrow(/HTTP 503/);
  });

  it('timeout → throws abort/timeout error', async () => {
    // Server never responds, so the abort fires after timeoutMs.
    mock = await startMock((_req, _res) => {
      // intentionally hang
    });
    const provider = makeProvider({ baseUrl: mock.baseUrl, timeoutMs: 100 });
    await expect(
      provider.send({ apiKey: 'tg', senderId: null, to: '+1', text: 'x' }),
    ).rejects.toThrow(/TextGuru send failed/);
  });

  it('missing apiKey → throws before making the request', async () => {
    const provider = makeProvider({ baseUrl: 'http://127.0.0.1:1' });
    await expect(
      provider.send({ apiKey: '', senderId: null, to: '+1', text: 'x' }),
    ).rejects.toThrow(/missing apiKey/);
  });

  it('TEXTGURU_BASE_URL not configured → throws with a helpful reason', async () => {
    const provider = makeProvider({ baseUrl: undefined });
    await expect(
      provider.send({ apiKey: 'tg', senderId: null, to: '+1', text: 'x' }),
    ).rejects.toThrow(/TEXTGURU_BASE_URL not configured/);
  });

  it('strips trailing slash from base URL', async () => {
    let captured: string | null = null;
    mock = await startMock((req, res) => {
      captured = req.url ?? '';
      res.statusCode = 200;
      res.end('');
    });
    const provider = makeProvider({ baseUrl: `${mock.baseUrl}/` });
    await provider.send({ apiKey: 'tg', senderId: null, to: '+1', text: 'x' });
    expect(captured).toBe('/api/v1/sms/send');
  });

  it('connection refused → throws (no listener on port 1)', async () => {
    const provider = makeProvider({ baseUrl: 'http://127.0.0.1:1' });
    await expect(
      provider.send({ apiKey: 'tg', senderId: null, to: '+1', text: 'x' }),
    ).rejects.toThrow(/TextGuru send failed/);
  });
});
