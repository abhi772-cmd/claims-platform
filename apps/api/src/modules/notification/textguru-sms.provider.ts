// Slice AR — real TextGuru SMS provider.
//
// Replaces the log-only stub in SmsAdapter for tenants that select
// provider='textguru' in their commsConfig. The per-tenant apiKey
// lives on tenant.commsConfig (KMS-wrapped at rest since AP); the
// gateway URL is platform-level (TEXTGURU_BASE_URL env var).
//
// Wire shape — matches the shared shape across major Indian SMS
// gateways (TextGuru, MSG91, TextLocal — they all converge on a
// JSON-over-HTTP POST with bearer auth):
//   POST <baseUrl>/api/v1/sms/send
//   Authorization: Bearer <apiKey>
//   Content-Type: application/json
//   { "to": "...", "message": "...", "senderId": "..." }
//
// Failure semantics: any non-2xx status, network error, or timeout
// throws. The upstream notification flow catches and marks the
// notification_outbox row as failed — the API request that triggered
// the notification stays successful (CLAUDE.md: "notification failure
// should not block the surrounding state change").

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { type AppConfig } from '../../config/configuration';

export interface TextGuruSendInput {
  apiKey: string;
  senderId: string | null;
  to: string;
  text: string;
}

@Injectable()
export class TextGuruSmsProvider {
  private readonly log = new Logger(TextGuruSmsProvider.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async send(input: TextGuruSendInput): Promise<void> {
    if (!input.apiKey) {
      // Catch the misconfig at the provider boundary instead of letting
      // it sail off as an opaque 401 from the gateway. Production
      // tenants should never reach this path because the admin UI
      // requires apiKey when selecting textguru.
      throw new Error('TextGuru send: missing apiKey on tenant commsConfig');
    }
    const baseUrl = this.config.get('TEXTGURU_BASE_URL', { infer: true });
    if (!baseUrl) {
      throw new Error(
        'TextGuru send: TEXTGURU_BASE_URL not configured (set the platform env)',
      );
    }
    const timeoutMs = this.config.get('TEXTGURU_HTTP_TIMEOUT_MS', { infer: true });

    const url = `${baseUrl.replace(/\/$/, '')}/api/v1/sms/send`;
    const body = JSON.stringify({
      to: input.to,
      message: input.text,
      ...(input.senderId !== null ? { senderId: input.senderId } : {}),
    });

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          'content-type': 'application/json',
        },
        body,
        signal: ac.signal,
      });
    } catch (err) {
      // AbortError (timeout) and network errors land here. Either way
      // it's transient — let the upstream record + retry.
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`TextGuru send failed: ${message}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // Pull the body for ops triage; keep it bounded so a misbehaving
      // gateway can't wedge the worker with a multi-megabyte error
      // payload.
      const text = (await res.text().catch(() => '')).slice(0, 500);
      throw new Error(`TextGuru send failed: HTTP ${res.status} ${text}`);
    }
    // We don't need the response body on success — the SMS is queued
    // at the gateway, the carrier dispatches asynchronously. Drain the
    // stream so the connection pool doesn't keep it open.
    await res.text().catch(() => undefined);
    this.log.debug(`textguru send ok to=${input.to} senderId=${input.senderId ?? '-'}`);
  }
}
