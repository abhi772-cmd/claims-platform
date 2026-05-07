// Slice AX — unit coverage for HttpEobOcrAdapter against a node:http
// mock inference server. Mirrors the TextGuru / ClamAV mock-server
// pattern: spin up a tiny HTTP listener, capture the multipart
// request, return canned JSON, assert the parsed shape.

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { type AddressInfo } from 'node:net';

import { type ConfigService } from '@nestjs/config';

import { HttpEobOcrAdapter } from './http-eob-ocr.adapter';
import { type AppConfig } from '../../config/configuration';
import { type StorageAdapter } from '../storage/storage-adapter.interface';

interface CapturedRequest {
  method: string;
  url: string;
  contentType: string;
  authorization: string;
  body: Buffer;
}

type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void;

async function startMock(handler: Handler): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => handler(req, res, Buffer.concat(chunks)));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((res) => {
            server.closeAllConnections();
            server.close(() => res());
          }),
      });
    });
  });
}

const failingStorage: StorageAdapter = {
  presignUpload: async () => {
    throw new Error('not used in these tests');
  },
  finalize: async () => {
    throw new Error('not used in these tests');
  },
  getObject: async () => {
    throw new Error('storage.getObject should not be called when buffer is provided');
  },
  presignDownload: async () => {
    throw new Error('not used in these tests');
  },
};

function makeAdapter(opts: {
  inferenceUrl?: string | undefined;
  apiKey?: string | undefined;
  timeoutMs?: number;
  storage?: StorageAdapter;
}): HttpEobOcrAdapter {
  const config = {
    get(key: string): unknown {
      if (key === 'EOB_OCR_INFERENCE_URL') return opts.inferenceUrl;
      if (key === 'EOB_OCR_API_KEY') return opts.apiKey;
      if (key === 'EOB_OCR_HTTP_TIMEOUT_MS') return opts.timeoutMs ?? 60_000;
      return undefined;
    },
  } as unknown as ConfigService<AppConfig, true>;
  return new HttpEobOcrAdapter(config, opts.storage ?? failingStorage);
}

describe('HttpEobOcrAdapter', () => {
  let mock: { baseUrl: string; close: () => Promise<void> } | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.close();
      mock = null;
    }
  });

  it('200 with extracted JSON → status=extracted with normalised fields', async () => {
    let captured: CapturedRequest | null = null;
    mock = await startMock((req, res, body) => {
      captured = {
        method: req.method ?? '',
        url: req.url ?? '',
        contentType: (req.headers['content-type'] as string | undefined) ?? '',
        authorization: (req.headers['authorization'] as string | undefined) ?? '',
        body,
      };
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          status: 'extracted',
          engine: 'paddle+qwen2vl',
          fields: {
            claimRefNum: 'STUB-CL-1',
            receivedAmount: 75000,
            deductionAmount: 25000,
            deductions: [
              { category: 'cap_exceeded', amount: 25000, reason: 'Cap exceeded' },
            ],
            shortPaymentReasons: ['Cap exceeded'],
            confidence: { claimRefNum: 0.92, receivedAmount: 0.88 },
          },
        }),
      );
    });
    const adapter = makeAdapter({ inferenceUrl: mock.baseUrl, apiKey: 'tg-secret' });
    const result = await adapter.extract({
      buffer: Buffer.from('PDF body bytes'),
      contentType: 'application/pdf',
      originalFilename: 'eob.pdf',
    });
    expect(result.status).toBe('extracted');
    expect(result.engine).toBe('paddle+qwen2vl');
    expect(result.fields?.claimRefNum).toBe('STUB-CL-1');
    expect(result.fields?.receivedAmount).toBe(75000);
    expect(result.fields?.deductionAmount).toBe(25000);
    expect(result.fields?.deductions).toEqual([
      { category: 'cap_exceeded', amount: 25000, reason: 'Cap exceeded' },
    ]);
    expect(result.fields?.confidence?.claimRefNum).toBeCloseTo(0.92);
    // Request shape: POSTed to /extract with multipart body, bearer
    // header, the document bytes embedded.
    expect(captured!.method).toBe('POST');
    expect(captured!.url).toBe('/extract');
    expect(captured!.authorization).toBe('Bearer tg-secret');
    expect(captured!.contentType).toMatch(/^multipart\/form-data;\s*boundary=/);
    expect(captured!.body.includes(Buffer.from('PDF body bytes'))).toBe(true);
  });

  it('200 with low_confidence + minimal fields → propagates as-is', async () => {
    mock = await startMock((_req, res) => {
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          status: 'low_confidence',
          engine: 'surya',
          fields: { deductions: [], shortPaymentReasons: [] },
        }),
      );
    });
    const adapter = makeAdapter({ inferenceUrl: mock.baseUrl });
    const result = await adapter.extract({ buffer: Buffer.from('x') });
    expect(result.status).toBe('low_confidence');
    expect(result.engine).toBe('surya');
    expect(result.fields).toEqual({ deductions: [], shortPaymentReasons: [] });
  });

  it('non-2xx response → status=failed with status code + body excerpt', async () => {
    mock = await startMock((_req, res) => {
      res.statusCode = 503;
      res.end('Service unavailable');
    });
    const adapter = makeAdapter({ inferenceUrl: mock.baseUrl });
    const result = await adapter.extract({ buffer: Buffer.from('x') });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/HTTP 503.*Service unavailable/);
  });

  it('malformed JSON → status=failed with parse error', async () => {
    mock = await startMock((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('not valid json {');
    });
    const adapter = makeAdapter({ inferenceUrl: mock.baseUrl });
    const result = await adapter.extract({ buffer: Buffer.from('x') });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/not valid JSON/);
  });

  it("response shape with invalid 'status' field → failed", async () => {
    mock = await startMock((_req, res) => {
      res.statusCode = 200;
      res.end(JSON.stringify({ status: 'wrong-shape', engine: 'paddle' }));
    });
    const adapter = makeAdapter({ inferenceUrl: mock.baseUrl });
    const result = await adapter.extract({ buffer: Buffer.from('x') });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/invalid status/);
  });

  it('extracted but missing fields → failed (defensive parse)', async () => {
    mock = await startMock((_req, res) => {
      res.statusCode = 200;
      res.end(JSON.stringify({ status: 'extracted', engine: 'paddle' }));
    });
    const adapter = makeAdapter({ inferenceUrl: mock.baseUrl });
    const result = await adapter.extract({ buffer: Buffer.from('x') });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/fields is missing/);
  });

  it('timeout → status=failed with abort error', async () => {
    mock = await startMock((_req, _res) => {
      // Hang — abort fires after timeoutMs.
    });
    const adapter = makeAdapter({ inferenceUrl: mock.baseUrl, timeoutMs: 100 });
    const result = await adapter.extract({ buffer: Buffer.from('x') });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/HTTP call failed/);
  });

  it('inference URL not configured → status=failed', async () => {
    const adapter = makeAdapter({ inferenceUrl: undefined });
    const result = await adapter.extract({ buffer: Buffer.from('x') });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/EOB_OCR_INFERENCE_URL/);
  });

  it('strips trailing slash from base URL', async () => {
    let captured: string | null = null;
    mock = await startMock((req, res) => {
      captured = req.url ?? '';
      res.statusCode = 200;
      res.end(JSON.stringify({ status: 'skipped', engine: 'x' }));
    });
    const adapter = makeAdapter({ inferenceUrl: `${mock.baseUrl}/` });
    await adapter.extract({ buffer: Buffer.from('x') });
    expect(captured).toBe('/extract');
  });

  it('Slice AS path: bucket/key only routes through storage.getObject', async () => {
    let getObjectCalls = 0;
    const stored = Buffer.from('S3 object body');
    const storage: StorageAdapter = {
      ...failingStorage,
      getObject: async () => {
        getObjectCalls += 1;
        return stored;
      },
    };
    let receivedBody: Buffer | null = null;
    mock = await startMock((_req, res, body) => {
      receivedBody = body;
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          status: 'extracted',
          engine: 'x',
          fields: { deductions: [], shortPaymentReasons: [] },
        }),
      );
    });
    const adapter = makeAdapter({ inferenceUrl: mock.baseUrl, storage });
    const result = await adapter.extract({
      storageBucket: 'b',
      storageKey: 'k',
      contentType: 'application/pdf',
      originalFilename: 'eob.pdf',
    });
    expect(result.status).toBe('extracted');
    expect(getObjectCalls).toBe(1);
    expect(receivedBody!.includes(stored)).toBe(true);
  });

  it('storage.getObject throws → failed with reason', async () => {
    const storage: StorageAdapter = {
      ...failingStorage,
      getObject: async () => {
        throw new Error('NoSuchKey');
      },
    };
    const adapter = makeAdapter({ inferenceUrl: 'http://127.0.0.1:1', storage });
    const result = await adapter.extract({ storageBucket: 'b', storageKey: 'k' });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Failed to fetch object.*NoSuchKey/);
  });

  it('neither buffer nor (bucket, key) → failed (caller bug)', async () => {
    const adapter = makeAdapter({ inferenceUrl: 'http://127.0.0.1:1' });
    const result = await adapter.extract({});
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/either buffer or \(storageBucket, storageKey\)/);
  });
});
