// Slice AX — HTTP-based real EOB OCR adapter. Bound when
// EOB_OCR_MODE='real'.
//
// Talks to any inference service that satisfies a small contract:
//   POST <EOB_OCR_INFERENCE_URL>/extract
//   Content-Type: multipart/form-data
//   Form fields:
//     file:        the document bytes (PDF / image)
//     filename:    original filename hint (optional)
//     contentType: declared MIME type (optional)
//   Optional: Authorization: Bearer <EOB_OCR_API_KEY>
//
// Response (200, application/json) shape:
//   {
//     "status": "extracted" | "low_confidence" | "skipped" | "failed",
//     "engine": string,
//     "fields"?: ExtractedEob,
//     "error"?: string
//   }
// — i.e., the same shape this adapter produces. The reference
// implementation is a small Python service that wraps
// PaddleOCR / Surya for OCR + Qwen2-VL / GOT-OCR2.0 for the
// structured-fields pass; users can run their own as long as it
// conforms.
//
// Failure semantics: non-2xx, network errors, timeouts, and JSON
// that doesn't parse against the contract all surface as
// `ScanResult { status: 'failed' }` with a triage-friendly error
// string. The caller (DocumentService.extractEob) returns that
// verbatim — operators see "OCR engine returned 503" or similar
// on the settlement screen and can retry or fall back to manual
// entry.

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  type EobOcrAdapter,
  type ExtractInput,
  type ExtractResult,
  type ExtractedEob,
} from './eob-ocr-adapter.interface';
import { type AppConfig } from '../../config/configuration';
import {
  STORAGE_ADAPTER,
  type StorageAdapter,
} from '../storage/storage-adapter.interface';

const ENGINE = 'http-remote';

@Injectable()
export class HttpEobOcrAdapter implements EobOcrAdapter {
  private readonly log = new Logger(HttpEobOcrAdapter.name);

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
  ) {}

  async extract(input: ExtractInput): Promise<ExtractResult> {
    const baseUrl = this.config.get('EOB_OCR_INFERENCE_URL', { infer: true });
    if (!baseUrl) {
      // The boot-time config check already rejects this for real
      // mode in production. The boot-time guard might be bypassed
      // in tests / dev; surface the misconfig clearly here too.
      return {
        status: 'failed',
        engine: ENGINE,
        error: 'EOB_OCR_INFERENCE_URL is not configured',
      };
    }

    let body: Buffer;
    if (input.buffer) {
      body = input.buffer;
    } else if (input.storageBucket && input.storageKey) {
      try {
        body = await this.storage.getObject({
          storageBucket: input.storageBucket,
          storageKey: input.storageKey,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn(
          `eob-ocr could not fetch object key=${input.storageKey} err=${message}`,
        );
        return {
          status: 'failed',
          engine: ENGINE,
          error: `Failed to fetch object for OCR: ${message}`,
        };
      }
    } else {
      return {
        status: 'failed',
        engine: ENGINE,
        error: 'HttpEobOcrAdapter requires either buffer or (storageBucket, storageKey)',
      };
    }

    const url = `${baseUrl.replace(/\/$/, '')}/extract`;
    const apiKey = this.config.get('EOB_OCR_API_KEY', { infer: true });
    const timeoutMs = this.config.get('EOB_OCR_HTTP_TIMEOUT_MS', { infer: true });

    const fd = new FormData();
    // Blob is a structured-clone-safe wrapper; modern Node fetch
    // serialises it as a multipart part with the right boundary.
    fd.append(
      'file',
      new Blob([body as unknown as ArrayBuffer], {
        type: input.contentType ?? 'application/octet-stream',
      }),
      input.originalFilename ?? 'document.bin',
    );
    if (input.originalFilename) fd.append('filename', input.originalFilename);
    if (input.contentType) fd.append('contentType', input.contentType);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        body: fd,
        signal: ac.signal,
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 'failed',
        engine: ENGINE,
        error: `OCR HTTP call failed: ${message}`,
      };
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 500);
      return {
        status: 'failed',
        engine: ENGINE,
        error: `OCR returned HTTP ${res.status}${text ? `: ${text}` : ''}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 'failed',
        engine: ENGINE,
        error: `OCR response is not valid JSON: ${message}`,
      };
    }

    return validateResponse(parsed);
  }
}

// Defensive parsing — the inference service is third-party-shaped
// from our perspective. We accept whatever it gives us, normalise
// to the contract, and reject (status='failed') if the shape is
// wrong enough that we can't trust the fields. The alternative
// would be a Zod schema; this handler is thin enough that
// hand-checking is clearer for now.
function validateResponse(raw: unknown): ExtractResult {
  if (!raw || typeof raw !== 'object') {
    return { status: 'failed', engine: ENGINE, error: 'OCR response is not an object' };
  }
  const obj = raw as Record<string, unknown>;
  const status = obj['status'];
  const engineRaw = obj['engine'];
  if (
    status !== 'extracted' &&
    status !== 'low_confidence' &&
    status !== 'skipped' &&
    status !== 'failed'
  ) {
    return {
      status: 'failed',
      engine: ENGINE,
      error: `OCR response has invalid status="${String(status)}"`,
    };
  }
  const engine = typeof engineRaw === 'string' && engineRaw.length > 0 ? engineRaw : ENGINE;
  if (status === 'failed') {
    return {
      status: 'failed',
      engine,
      error: typeof obj['error'] === 'string' ? (obj['error'] as string) : undefined,
    } as ExtractResult;
  }
  if (status === 'skipped') {
    return { status: 'skipped', engine };
  }
  // 'extracted' or 'low_confidence' — fields are required, defensive
  // about per-field types so a sloppy upstream can't poison our DB
  // when the next slice persists these.
  const fieldsRaw = obj['fields'];
  if (!fieldsRaw || typeof fieldsRaw !== 'object') {
    return {
      status: 'failed',
      engine: ENGINE,
      error: `OCR response status=${status} but fields is missing`,
    };
  }
  const f = fieldsRaw as Record<string, unknown>;
  const fields: ExtractedEob = {
    deductions: Array.isArray(f['deductions'])
      ? (f['deductions'] as unknown[])
          .filter((d): d is Record<string, unknown> => Boolean(d) && typeof d === 'object')
          .map((d) => ({
            category: typeof d['category'] === 'string' ? (d['category'] as string) : '',
            amount: typeof d['amount'] === 'number' ? Math.max(0, Math.trunc(d['amount'] as number)) : 0,
            ...(typeof d['reason'] === 'string' ? { reason: d['reason'] as string } : {}),
          }))
      : [],
    shortPaymentReasons: Array.isArray(f['shortPaymentReasons'])
      ? (f['shortPaymentReasons'] as unknown[]).filter(
          (s): s is string => typeof s === 'string',
        )
      : [],
  };
  if (typeof f['claimRefNum'] === 'string') fields.claimRefNum = f['claimRefNum'] as string;
  if (typeof f['receivedAmount'] === 'number') {
    fields.receivedAmount = Math.max(0, Math.trunc(f['receivedAmount'] as number));
  }
  if (typeof f['deductionAmount'] === 'number') {
    fields.deductionAmount = Math.max(0, Math.trunc(f['deductionAmount'] as number));
  }
  if (typeof f['bankTxnId'] === 'string') fields.bankTxnId = f['bankTxnId'] as string;
  if (typeof f['receivedAt'] === 'string') fields.receivedAt = f['receivedAt'] as string;
  if (f['confidence'] && typeof f['confidence'] === 'object') {
    const c = f['confidence'] as Record<string, unknown>;
    fields.confidence = {};
    for (const k of [
      'claimRefNum',
      'receivedAmount',
      'deductionAmount',
      'bankTxnId',
      'receivedAt',
    ] as const) {
      if (typeof c[k] === 'number') {
        fields.confidence[k] = Math.max(0, Math.min(1, c[k] as number));
      }
    }
  }
  return { status, engine, fields };
}
