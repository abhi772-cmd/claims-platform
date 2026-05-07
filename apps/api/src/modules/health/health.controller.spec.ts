// Slice BE — unit coverage for the deep-readiness probe. We
// don't boot the full Nest app — just instantiate the controller
// with a stub Prisma + ConfigService and run the probes against
// node:net + node:http mocks, mirroring the pattern from
// clamav-scan.adapter.spec and http-eob-ocr.adapter.spec.

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { type AddressInfo, createServer as createNetServer, type Server as NetServer } from 'node:net';

import { type ConfigService } from '@nestjs/config';

import { HealthController } from './health.controller';
import { type PrismaService } from '../../common/prisma/prisma.service';
import { type AppConfig } from '../../config/configuration';

interface ConfigOverrides {
  VIRUS_SCAN_MODE?: 'off' | 'stub' | 'real';
  VIRUS_SCAN_ENDPOINT?: string;
  EOB_OCR_MODE?: 'off' | 'stub' | 'real';
  EOB_OCR_INFERENCE_URL?: string;
}

function makeController(overrides: ConfigOverrides = {}): HealthController {
  const config = {
    get(key: string): unknown {
      if (key === 'VIRUS_SCAN_MODE') return overrides.VIRUS_SCAN_MODE ?? 'off';
      if (key === 'VIRUS_SCAN_ENDPOINT') return overrides.VIRUS_SCAN_ENDPOINT;
      if (key === 'EOB_OCR_MODE') return overrides.EOB_OCR_MODE ?? 'off';
      if (key === 'EOB_OCR_INFERENCE_URL') return overrides.EOB_OCR_INFERENCE_URL;
      // The /ready handler asks for these too — return safe stubs so
      // it doesn't crash on the path our deep probe shares.
      if (key === 'NHCX_MODE') return 'stub';
      if (key === 'HPR_MODE') return 'stub';
      if (key === 'STORAGE_MODE') return 'stub';
      return undefined;
    },
  } as unknown as ConfigService<AppConfig, true>;
  // Prisma stub — DB ping returns ok, migrations check returns
  // a single applied row. The cheap /ready path runs as part of
  // /ready/deep; we want it to land on `status: 'ok'` so the deep
  // checks are what we're actually asserting.
  const prisma = {
    $queryRaw: async (): Promise<Array<{ unfinished: bigint; rolled_back: bigint; total: bigint }>> => [
      { unfinished: 0n, rolled_back: 0n, total: 1n },
    ],
  } as unknown as PrismaService;
  return new HealthController(prisma, config);
}

async function startClamdMock(
  reply: 'PONG' | 'silent' | 'close',
): Promise<{ endpoint: string; close: () => Promise<void> }> {
  const server: NetServer = createNetServer((sock) => {
    sock.on('data', () => {
      if (reply === 'PONG') {
        sock.write(Buffer.from('PONG\0', 'utf8'));
      } else if (reply === 'close') {
        sock.destroy();
      }
      // 'silent' → never replies; client times out.
    });
    sock.on('error', () => undefined);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        endpoint: `127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((res) => {
            // The mock-clamd test cases all settle via reply or
            // abrupt-destroy before we close, so close() drains
            // immediately without needing an explicit connection
            // sweep.
            server.close(() => res());
          }),
      });
    });
  });
}

type HttpHandler = (req: IncomingMessage, res: ServerResponse) => void;

async function startHttpMock(
  handler: HttpHandler,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: HttpServer = createHttpServer(handler);
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

describe('HealthController.readyDeep', () => {
  it('off mode for both → both probes skipped, overall ok', async () => {
    const controller = makeController({});
    const out = await controller.readyDeep();
    expect(out.deep.clamav.status).toBe('skipped');
    expect(out.deep.eobOcr.status).toBe('skipped');
    expect(out.status).toBe('ok');
  });

  it('clamav real-mode + healthy clamd → ok', async () => {
    const mock = await startClamdMock('PONG');
    try {
      const controller = makeController({
        VIRUS_SCAN_MODE: 'real',
        VIRUS_SCAN_ENDPOINT: mock.endpoint,
      });
      const out = await controller.readyDeep();
      expect(out.deep.clamav.status).toBe('ok');
      expect(out.deep.clamav.latencyMs).toBeGreaterThanOrEqual(0);
      expect(out.status).toBe('ok');
    } finally {
      await mock.close();
    }
  });

  it('clamav real-mode + abrupt close → failed', async () => {
    const mock = await startClamdMock('close');
    try {
      const controller = makeController({
        VIRUS_SCAN_MODE: 'real',
        VIRUS_SCAN_ENDPOINT: mock.endpoint,
      });
      const out = await controller.readyDeep();
      expect(out.deep.clamav.status).toBe('failed');
      expect(out.status).toBe('degraded');
    } finally {
      await mock.close();
    }
  });

  it('clamav real-mode + missing endpoint → failed before connect', async () => {
    const controller = makeController({ VIRUS_SCAN_MODE: 'real' });
    const out = await controller.readyDeep();
    expect(out.deep.clamav.status).toBe('failed');
    expect(out.deep.clamav.reason).toMatch(/VIRUS_SCAN_ENDPOINT/);
    expect(out.status).toBe('degraded');
  });

  it('clamav real-mode + connection refused → failed quickly', async () => {
    const controller = makeController({
      VIRUS_SCAN_MODE: 'real',
      VIRUS_SCAN_ENDPOINT: '127.0.0.1:1',
    });
    const out = await controller.readyDeep();
    expect(out.deep.clamav.status).toBe('failed');
    expect(out.deep.clamav.reason).toMatch(/connect/i);
  });

  it('eob ocr real-mode + alive server (any 2xx/4xx) → ok', async () => {
    const mock = await startHttpMock((_req, res) => {
      // 405 is what an inference service typically returns on HEAD /.
      res.statusCode = 405;
      res.end();
    });
    try {
      const controller = makeController({
        EOB_OCR_MODE: 'real',
        EOB_OCR_INFERENCE_URL: mock.baseUrl,
      });
      const out = await controller.readyDeep();
      expect(out.deep.eobOcr.status).toBe('ok');
      expect(out.status).toBe('ok');
    } finally {
      await mock.close();
    }
  });

  it('eob ocr real-mode + 503 → failed', async () => {
    const mock = await startHttpMock((_req, res) => {
      res.statusCode = 503;
      res.end();
    });
    try {
      const controller = makeController({
        EOB_OCR_MODE: 'real',
        EOB_OCR_INFERENCE_URL: mock.baseUrl,
      });
      const out = await controller.readyDeep();
      expect(out.deep.eobOcr.status).toBe('failed');
      expect(out.deep.eobOcr.reason).toMatch(/HTTP 503/);
      expect(out.status).toBe('degraded');
    } finally {
      await mock.close();
    }
  });

  it('eob ocr real-mode + missing URL → failed', async () => {
    const controller = makeController({ EOB_OCR_MODE: 'real' });
    const out = await controller.readyDeep();
    expect(out.deep.eobOcr.status).toBe('failed');
    expect(out.deep.eobOcr.reason).toMatch(/EOB_OCR_INFERENCE_URL/);
    expect(out.status).toBe('degraded');
  });

  it('eob ocr real-mode + connection refused → failed', async () => {
    const controller = makeController({
      EOB_OCR_MODE: 'real',
      EOB_OCR_INFERENCE_URL: 'http://127.0.0.1:1',
    });
    const out = await controller.readyDeep();
    expect(out.deep.eobOcr.status).toBe('failed');
  });

  it('both probes ok in parallel → status ok', async () => {
    const clamMock = await startClamdMock('PONG');
    const eobMock = await startHttpMock((_req, res) => {
      res.statusCode = 200;
      res.end();
    });
    try {
      const controller = makeController({
        VIRUS_SCAN_MODE: 'real',
        VIRUS_SCAN_ENDPOINT: clamMock.endpoint,
        EOB_OCR_MODE: 'real',
        EOB_OCR_INFERENCE_URL: eobMock.baseUrl,
      });
      const out = await controller.readyDeep();
      expect(out.deep.clamav.status).toBe('ok');
      expect(out.deep.eobOcr.status).toBe('ok');
      expect(out.status).toBe('ok');
    } finally {
      await clamMock.close();
      await eobMock.close();
    }
  });
});
