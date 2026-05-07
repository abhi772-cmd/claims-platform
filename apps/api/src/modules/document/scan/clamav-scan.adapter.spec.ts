// Slice AQ — unit coverage for the real ClamAV adapter. Stands up a
// tiny in-memory TCP server that pretends to be clamd, asserting both
// directions of the INSTREAM exchange:
//   - the bytes the adapter sent over the socket follow the protocol
//   - the parsed reply maps the right ClamAV verdict to ScanResult
//
// We do this with `node:net` rather than testcontainers so the test
// runs anywhere — including the typecheck-only CI lane — without
// shipping a real virus.

import { type AddressInfo, createServer, type Server, type Socket } from 'node:net';

import { type ConfigService } from '@nestjs/config';

import { ClamAvScanAdapter, parseInstreamReply } from './clamav-scan.adapter';
import { type AppConfig } from '../../../config/configuration';
import {
  type GetObjectInput,
  type StorageAdapter,
} from '../../storage/storage-adapter.interface';

interface CapturedRequest {
  // Everything the client sent before EOS, normalised: the leading
  // command bytes followed by the concatenated body bytes (so tests
  // can grep for command + payload independently).
  command: string;
  payload: Buffer;
}

// Tiny clamd impostor. The handler decides what reply bytes to send
// (or whether to close the socket abruptly to simulate a crash).
function startMockClamd(handler: (req: CapturedRequest) => Buffer | 'close'): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server: Server = createServer((sock: Socket) => {
    let buf = Buffer.alloc(0);
    let command = '';
    const payloadChunks: Buffer[] = [];
    let phase: 'command' | 'chunks' = 'command';

    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      // Phase 1: read up to and including the NUL terminator that ends
      // `zINSTREAM\0`.
      if (phase === 'command') {
        const nulIdx = buf.indexOf(0);
        if (nulIdx === -1) return;
        command = buf.subarray(0, nulIdx).toString('utf8');
        buf = buf.subarray(nulIdx + 1);
        phase = 'chunks';
      }
      // Phase 2: parse [4-byte BE length][length bytes] frames until
      // a zero-length sentinel.
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          buf = buf.subarray(4);
          const reply = handler({
            command,
            payload: Buffer.concat(payloadChunks),
          });
          if (reply === 'close') {
            sock.destroy();
          } else {
            sock.end(reply);
          }
          return;
        }
        if (buf.length < 4 + len) return;
        payloadChunks.push(buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
      }
    });
    sock.on('error', () => undefined);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

// Minimal storage stub for the buffer-path tests — getObject throws if
// called, signalling that any test which reaches it is using the wrong
// fixture shape.
function neverGetObjectStorage(): StorageAdapter {
  return {
    presignUpload: async () => {
      throw new Error('not used in these tests');
    },
    finalize: async () => {
      throw new Error('not used in these tests');
    },
    getObject: async () => {
      throw new Error('storage.getObject should not be called when buffer is provided');
    },
  };
}

function makeAdapter(
  endpoint: string | null,
  storage: StorageAdapter = neverGetObjectStorage(),
): ClamAvScanAdapter {
  const config = {
    get(key: string): string | null | undefined {
      if (key === 'VIRUS_SCAN_ENDPOINT') return endpoint;
      return undefined;
    },
  } as unknown as ConfigService<AppConfig, true>;
  return new ClamAvScanAdapter(config, storage);
}

describe('parseInstreamReply', () => {
  it('clean → status=clean', () => {
    expect(parseInstreamReply(Buffer.from('stream: OK'))).toEqual({
      status: 'clean',
      engine: 'clamav',
    });
  });

  it('found → status=infected with signature', () => {
    expect(
      parseInstreamReply(Buffer.from('stream: Eicar-Test-Signature FOUND')),
    ).toEqual({
      status: 'infected',
      engine: 'clamav',
      signature: 'Eicar-Test-Signature',
    });
  });

  it('handles signatures with hyphens / dots', () => {
    expect(
      parseInstreamReply(Buffer.from('stream: Win.Trojan.Foo-1234 FOUND')),
    ).toEqual({
      status: 'infected',
      engine: 'clamav',
      signature: 'Win.Trojan.Foo-1234',
    });
  });

  it('error reply → status=failed with message', () => {
    const result = parseInstreamReply(Buffer.from('INSTREAM size limit exceeded. ERROR'));
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/size limit/);
  });

  it('empty reply → status=failed', () => {
    const result = parseInstreamReply(Buffer.from(''));
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/empty/);
  });
});

describe('ClamAvScanAdapter (TCP)', () => {
  let mock: { port: number; close: () => Promise<void> } | null = null;

  afterEach(async () => {
    if (mock) {
      await mock.close();
      mock = null;
    }
  });

  it('clean buffer → status=clean and command/payload reach clamd verbatim', async () => {
    let captured: CapturedRequest | null = null;
    mock = await startMockClamd((req) => {
      captured = req;
      return Buffer.from('stream: OK\0');
    });
    const adapter = makeAdapter(`127.0.0.1:${mock.port}`);
    const body = Buffer.from('Hello, document body. PDF bytes here.', 'utf8');

    const result = await adapter.scan({ buffer: body });
    expect(result).toEqual({ status: 'clean', engine: 'clamav' });
    expect(captured).not.toBeNull();
    expect(captured!.command).toBe('zINSTREAM');
    expect(captured!.payload.equals(body)).toBe(true);
  });

  it('EICAR buffer → status=infected with signature from clamd reply', async () => {
    mock = await startMockClamd(() =>
      Buffer.from('stream: Eicar-Test-Signature FOUND\0'),
    );
    const adapter = makeAdapter(`127.0.0.1:${mock.port}`);
    const result = await adapter.scan({ buffer: Buffer.from('payload') });
    expect(result).toEqual({
      status: 'infected',
      engine: 'clamav',
      signature: 'Eicar-Test-Signature',
    });
  });

  it('chunk-boundary correctness — payload larger than a single chunk arrives intact', async () => {
    // 130 KiB is past the 64 KiB chunk size so the adapter has to send
    // two length-prefixed frames. The mock reassembles and we compare.
    let captured: CapturedRequest | null = null;
    mock = await startMockClamd((req) => {
      captured = req;
      return Buffer.from('stream: OK\0');
    });
    const adapter = makeAdapter(`127.0.0.1:${mock.port}`);
    const big = Buffer.alloc(130 * 1024);
    for (let i = 0; i < big.length; i += 1) big[i] = i & 0xff;
    const result = await adapter.scan({ buffer: big });
    expect(result.status).toBe('clean');
    expect(captured!.payload.length).toBe(big.length);
    expect(captured!.payload.equals(big)).toBe(true);
  });

  it('clamd closing the socket without reply → status=failed', async () => {
    mock = await startMockClamd(() => 'close');
    const adapter = makeAdapter(`127.0.0.1:${mock.port}`);
    const result = await adapter.scan({ buffer: Buffer.from('payload') });
    expect(result.status).toBe('failed');
  });

  it('Slice AS — bucket/key only (no buffer): fetches from storage and scans', async () => {
    let capturedReq: CapturedRequest | null = null;
    mock = await startMockClamd((req) => {
      capturedReq = req;
      return Buffer.from('stream: OK\0');
    });
    let getObjectCall: GetObjectInput | null = null;
    const stored = Buffer.from('S3 object body bytes');
    const storage: StorageAdapter = {
      presignUpload: async () => {
        throw new Error('not used');
      },
      finalize: async () => {
        throw new Error('not used');
      },
      getObject: async (input) => {
        getObjectCall = input;
        return stored;
      },
    };
    const adapter = makeAdapter(`127.0.0.1:${mock.port}`, storage);
    const result = await adapter.scan({
      storageBucket: 'claims-prod',
      storageKey: 'tenant-1/claim-9/doc.pdf',
      contentType: 'application/pdf',
    });
    expect(result).toEqual({ status: 'clean', engine: 'clamav' });
    expect(getObjectCall).toEqual({
      storageBucket: 'claims-prod',
      storageKey: 'tenant-1/claim-9/doc.pdf',
    });
    // The exact bytes returned by storage are what reached clamd —
    // no transcoding, no JSON wrapping.
    expect(capturedReq!.payload.equals(stored)).toBe(true);
  });

  it('Slice AS — bucket/key only with EICAR-shaped object → status=infected', async () => {
    mock = await startMockClamd(() =>
      Buffer.from('stream: Eicar-Test-Signature FOUND\0'),
    );
    const storage: StorageAdapter = {
      presignUpload: async () => {
        throw new Error('not used');
      },
      finalize: async () => {
        throw new Error('not used');
      },
      getObject: async () => Buffer.from('EICAR-style payload'),
    };
    const adapter = makeAdapter(`127.0.0.1:${mock.port}`, storage);
    const result = await adapter.scan({
      storageBucket: 'b',
      storageKey: 'k',
    });
    expect(result.status).toBe('infected');
    expect(result.signature).toBe('Eicar-Test-Signature');
  });

  it('Slice AS — storage.getObject throws → status=failed with reason', async () => {
    const storage: StorageAdapter = {
      presignUpload: async () => {
        throw new Error('not used');
      },
      finalize: async () => {
        throw new Error('not used');
      },
      getObject: async () => {
        throw new Error('AccessDenied: bucket policy rejected');
      },
    };
    const adapter = makeAdapter('127.0.0.1:1', storage);
    const result = await adapter.scan({ storageBucket: 'b', storageKey: 'k' });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Failed to fetch object.*AccessDenied/);
  });

  it('neither buffer nor (bucket, key) → status=failed (caller bug)', async () => {
    const adapter = makeAdapter('127.0.0.1:1');
    const result = await adapter.scan({});
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/either buffer or \(storageBucket, storageKey\)/);
  });

  it('endpoint not configured → status=failed', async () => {
    const adapter = makeAdapter(null);
    const result = await adapter.scan({ buffer: Buffer.from('x') });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/VIRUS_SCAN_ENDPOINT/);
  });

  it('connection refused → status=failed', async () => {
    // Port 1 with nothing listening — connect() rejects fast.
    const adapter = makeAdapter('127.0.0.1:1');
    const result = await adapter.scan({ buffer: Buffer.from('x') });
    expect(result.status).toBe('failed');
  });
});
