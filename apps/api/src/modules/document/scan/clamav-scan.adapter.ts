// Slice AQ — real ClamAV INSTREAM adapter.
//
// Implements the INSTREAM command from the clamd protocol:
//   1. Connect over TCP to clamd (default :3310).
//   2. Send `zINSTREAM\0` (z-prefixed, null-terminated → clamd will
//      respond with a null-terminated reply).
//   3. Stream the bytes as length-prefixed chunks: 4-byte big-endian
//      length followed by `length` bytes. Repeat for each chunk.
//   4. Send a 4-byte zero length to mark end-of-stream.
//   5. Read the response. clamd answers either:
//        `stream: OK\0`                                — clean
//        `stream: <Signature> FOUND\0`                 — infected
//        `INSTREAM size limit exceeded. ERROR\0`       — failed
//        `... ERROR\0`                                 — generic failure
//
// Two input paths:
//   1. `buffer` — the original API-server upload route handed us the
//      bytes in memory. Scan straight from RAM.
//   2. `storageBucket` + `storageKey` (Slice AS) — the presigned-PUT
//      flow (STORAGE_MODE=real) means the bytes never crossed the API
//      server. Pull them back via the StorageAdapter and scan. We
//      drain into a Buffer (capped by S3_MAX_UPLOAD_BYTES, default
//      50 MiB, so it fits in a worker's heap) before streaming to
//      clamd because the INSTREAM protocol expects framed chunks.

import { Socket } from 'node:net';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  type ScanInput,
  type ScanResult,
  type VirusScanAdapter,
} from './virus-scan-adapter.interface';
import { type AppConfig } from '../../../config/configuration';
import {
  STORAGE_ADAPTER,
  type StorageAdapter,
} from '../../storage/storage-adapter.interface';

// clamd's default chunk size cap is 25 MiB but it accepts smaller; 64 KiB
// is the sweet spot — enough to amortise the per-chunk header, small
// enough to play nicely with the socket write buffer.
const CHUNK_BYTES = 64 * 1024;
// Hard ceiling so a malformed payload can't pin a worker forever. 60s
// is generous — real scans of <50 MiB documents are sub-second.
const SOCKET_TIMEOUT_MS = 60_000;
const ENGINE = 'clamav';

@Injectable()
export class ClamAvScanAdapter implements VirusScanAdapter {
  private readonly log = new Logger(ClamAvScanAdapter.name);

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
  ) {}

  async scan(input: ScanInput): Promise<ScanResult> {
    let body: Buffer;
    if (input.buffer) {
      body = input.buffer;
    } else if (input.storageBucket && input.storageKey) {
      // Slice AS — pull the bytes from S3 (or whichever real adapter
      // is wired). StubStorageAdapter throws here on purpose; the
      // resulting failure surfaces a misconfiguration where someone
      // has VIRUS_SCAN_MODE=real with STORAGE_MODE=stub.
      try {
        body = await this.storage.getObject({
          storageBucket: input.storageBucket,
          storageKey: input.storageKey,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn(
          `clamav scan could not fetch object key=${input.storageKey} err=${message}`,
        );
        return {
          status: 'failed',
          engine: ENGINE,
          error: `Failed to fetch object for scanning: ${message}`,
        };
      }
    } else {
      // No buffer AND no (bucket, key) — caller bug. Don't pass as clean.
      return {
        status: 'failed',
        engine: ENGINE,
        error: 'ClamAV adapter requires either buffer or (storageBucket, storageKey)',
      };
    }
    const endpoint = this.config.get('VIRUS_SCAN_ENDPOINT', { infer: true });
    if (!endpoint) {
      return {
        status: 'failed',
        engine: ENGINE,
        error: 'VIRUS_SCAN_ENDPOINT is not configured',
      };
    }
    const [host, portStr] = endpoint.split(':');
    const port = Number.parseInt(portStr ?? '3310', 10);
    if (!host || !Number.isFinite(port) || port <= 0) {
      return {
        status: 'failed',
        engine: ENGINE,
        error: `Invalid VIRUS_SCAN_ENDPOINT: ${endpoint}`,
      };
    }
    try {
      const reply = await this.sendInstream(host, port, body);
      return parseInstreamReply(reply);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`clamav scan failed host=${host} port=${port} err=${message}`);
      return { status: 'failed', engine: ENGINE, error: message };
    }
  }

  // Open a fresh socket per scan — clamd handles connection-per-command
  // by design, and we don't keep a pool because the worker concurrency
  // is already low. Returns the raw reply bytes (without the trailing
  // null) so the parser can match the protocol exactly.
  private sendInstream(host: string, port: number, body: Buffer): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const socket = new Socket();
      const chunks: Buffer[] = [];
      let settled = false;

      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        socket.removeAllListeners();
        socket.destroy();
        action();
      };

      socket.setTimeout(SOCKET_TIMEOUT_MS);
      socket.once('timeout', () => {
        settle(() => reject(new Error(`clamd socket timed out after ${SOCKET_TIMEOUT_MS}ms`)));
      });
      socket.once('error', (err) => {
        settle(() => reject(err));
      });
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      socket.once('close', () => {
        settle(() => resolve(stripTrailingNull(Buffer.concat(chunks))));
      });
      socket.connect(port, host, () => {
        try {
          // Prefix with the `z` command form so the response carries a
          // trailing NUL, which makes the reply boundary unambiguous
          // even though we use connection close as the framing signal.
          socket.write(Buffer.from('zINSTREAM\0', 'utf8'));
          for (let offset = 0; offset < body.length; offset += CHUNK_BYTES) {
            const slice = body.subarray(offset, Math.min(offset + CHUNK_BYTES, body.length));
            const header = Buffer.alloc(4);
            header.writeUInt32BE(slice.length, 0);
            socket.write(header);
            socket.write(slice);
          }
          // End-of-stream marker: 4-byte zero length. clamd replies and
          // closes the connection, which fires our 'close' handler.
          const eos = Buffer.alloc(4);
          eos.writeUInt32BE(0, 0);
          socket.write(eos);
        } catch (err) {
          settle(() => reject(err));
        }
      });
    });
  }
}

function stripTrailingNull(buf: Buffer): Buffer {
  if (buf.length > 0 && buf[buf.length - 1] === 0) return buf.subarray(0, buf.length - 1);
  return buf;
}

// Exported for unit tests so the parser can be exercised without
// standing up a TCP server.
export function parseInstreamReply(reply: Buffer): ScanResult {
  const text = reply.toString('utf8').trim();
  if (text === 'stream: OK') {
    return { status: 'clean', engine: ENGINE };
  }
  // Format: `stream: <Signature> FOUND` (signature may contain dots,
  // hyphens, dot-separated fragments; never spaces in known engines).
  const foundMatch = /^stream:\s+(\S.*)\s+FOUND$/.exec(text);
  if (foundMatch) {
    return {
      status: 'infected',
      engine: ENGINE,
      signature: foundMatch[1] ?? 'unknown',
    };
  }
  // Anything else is a failure — INSTREAM size limit, broken pipe,
  // unknown command, etc. Keep the raw text for ops triage.
  return {
    status: 'failed',
    engine: ENGINE,
    error: `Unexpected clamd reply: ${text || '<empty>'}`,
  };
}
