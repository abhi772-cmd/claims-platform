// HTTP-based real bill-OCR adapter. Bound when BILL_OCR_MODE='real'.
//
// Talks to the same inference service as EOB OCR (reuses
// EOB_OCR_INFERENCE_URL / EOB_OCR_API_KEY / EOB_OCR_HTTP_TIMEOUT_MS),
// but POSTs to its /extract-bill route:
//   POST <EOB_OCR_INFERENCE_URL>/extract-bill
//   Content-Type: multipart/form-data
//   Form fields: file, filename, contentType
//   Optional: Authorization: Bearer <EOB_OCR_API_KEY>
//
// Response (200, application/json):
//   { "status": "extracted"|"low_confidence"|"skipped"|"failed",
//     "engine": string,
//     "lines"?: [{ "description": string, "amountPaise": number }],
//     "error"?: string }
//
// Failure semantics mirror HttpEobOcrAdapter: non-2xx, network errors,
// timeouts, and unparseable JSON all surface as
// `BillExtractResult { status: 'failed' }` with a triage-friendly
// error string. The caller returns that verbatim so the operator can
// retry or fall back to pasting the bill.

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  type BillExtractInput,
  type BillExtractResult,
  type BillOcrAdapter,
  type BillOcrLine,
} from './bill-ocr-adapter.interface';
import { type AppConfig } from '../../config/configuration';

const ENGINE = 'http-remote';

@Injectable()
export class HttpBillOcrAdapter implements BillOcrAdapter {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async extractBill(input: BillExtractInput): Promise<BillExtractResult> {
    const baseUrl = this.config.get('EOB_OCR_INFERENCE_URL', { infer: true });
    if (!baseUrl) {
      return {
        status: 'failed',
        engine: ENGINE,
        lines: [],
        error: 'EOB_OCR_INFERENCE_URL is not configured',
      };
    }

    const url = `${baseUrl.replace(/\/$/, '')}/extract-bill`;
    const apiKey = this.config.get('EOB_OCR_API_KEY', { infer: true });
    const timeoutMs = this.config.get('EOB_OCR_HTTP_TIMEOUT_MS', { infer: true });

    const fd = new FormData();
    fd.append(
      'file',
      new Blob([input.buffer as unknown as ArrayBuffer], {
        type: input.contentType ?? 'application/octet-stream',
      }),
      input.originalFilename ?? 'bill.bin',
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
        lines: [],
        error: `Bill OCR HTTP call failed: ${message}`,
      };
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 500);
      return {
        status: 'failed',
        engine: ENGINE,
        lines: [],
        error: `Bill OCR returned HTTP ${res.status}${text ? `: ${text}` : ''}`,
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
        lines: [],
        error: `Bill OCR response is not valid JSON: ${message}`,
      };
    }

    return validateResponse(parsed);
  }
}

// Defensive parsing — the inference service is third-party-shaped from
// our perspective. Normalise to the contract; reject (status='failed')
// when the shape is wrong enough that we can't trust it.
function validateResponse(raw: unknown): BillExtractResult {
  if (!raw || typeof raw !== 'object') {
    return { status: 'failed', engine: ENGINE, lines: [], error: 'Bill OCR response is not an object' };
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
      lines: [],
      error: `Bill OCR response has invalid status="${String(status)}"`,
    };
  }
  const engine = typeof engineRaw === 'string' && engineRaw.length > 0 ? engineRaw : ENGINE;
  if (status === 'failed') {
    return {
      status: 'failed',
      engine,
      lines: [],
      error: typeof obj['error'] === 'string' ? (obj['error'] as string) : undefined,
    };
  }
  if (status === 'skipped') {
    return { status: 'skipped', engine, lines: [] };
  }
  // 'extracted' or 'low_confidence' — parse lines defensively so a
  // sloppy upstream can't poison the classifier.
  const lines = parseLines(obj['lines']);
  return { status, engine, lines };
}

function parseLines(raw: unknown): BillOcrLine[] {
  if (!Array.isArray(raw)) return [];
  const out: BillOcrLine[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const description = typeof row['description'] === 'string' ? row['description'].trim() : '';
    if (!description) continue;
    const amountPaise =
      typeof row['amountPaise'] === 'number'
        ? Math.max(0, Math.trunc(row['amountPaise']))
        : 0;
    out.push({ description, amountPaise });
  }
  return out;
}
