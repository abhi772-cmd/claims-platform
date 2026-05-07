// Slice BF — Real ABDM biometric auth adapter. Bound when
// BIOMETRIC_AUTH_MODE='real'. Posts to the ABDM-hosted endpoints
// documented in the PMJAY supporting docs:
//
//   POST  <BASE>/hcx/abha/biometric/auth/init
//   POST  <BASE>/hcx/abha/biometric/auth/verify
//   GET   <BASE>/hcx/abha/biometric/auth/refresh/token
//
// Required headers on every call:
//   accept: application/json
//   Content-Type: application/json   (init + verify)
//   Authorization: Bearer <bearerToken>   (outer ABHA-platform JWT)
//   process: Preauth | Discharge          (which side of the case)
//   payerid: <payer NHCX participant id>  (PMJAY payer routing)
//
// Refresh additionally takes:
//   R-token: Bearer <refreshToken>        (handle from prior verify)
//
// Failure semantics: any non-2xx, network error, timeout, or JSON
// that doesn't parse against the contract surfaces as
// `{ status: 'failed', error: <triage-friendly message> }`. The
// caller (Slice BG) decides whether to surface to the operator and
// retry vs. abandon the session — the adapter is dumb plumbing.
//
// The PID blocks (fingerPrintAuthPid / faceAuthPid / irisAuthPid)
// are device-encrypted opaque blobs we never log. The bearerToken
// and refreshToken are also short-lived secrets — also never logged.

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  type BiometricAuthAdapter,
  type BiometricInitInput,
  type BiometricInitResult,
  type BiometricRefreshInput,
  type BiometricRefreshResult,
  type BiometricVerifyInput,
  type BiometricVerifyResult,
} from './biometric-auth-adapter.interface';
import { type AppConfig } from '../../config/configuration';

@Injectable()
export class HttpBiometricAuthAdapter implements BiometricAuthAdapter {
  private readonly log = new Logger(HttpBiometricAuthAdapter.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async init(input: BiometricInitInput): Promise<BiometricInitResult> {
    const url = this.endpoint('/hcx/abha/biometric/auth/init');
    if (!url) {
      return { status: 'failed', error: 'BIOMETRIC_AUTH_BASE_URL is not configured' };
    }
    const body = {
      scope: ['abha-login', input.scope],
      loginHint: input.loginHint,
      loginId: input.loginId,
      otpSystem: 'aadhaar',
      authMode: input.authMode,
    };
    const result = await this.postJson(url, body, {
      Authorization: `Bearer ${input.bearerToken}`,
      process: input.process,
      payerid: input.payerId,
    });
    if (result.kind === 'error') {
      return { status: 'failed', error: result.error };
    }
    const obj = result.body as Record<string, unknown>;
    const txnId = typeof obj['txnId'] === 'string' ? (obj['txnId'] as string) : undefined;
    if (!txnId) {
      return {
        status: 'failed',
        error: 'ABDM init response did not include a txnId',
      };
    }
    return { status: 'init_ok', txnId };
  }

  async verify(input: BiometricVerifyInput): Promise<BiometricVerifyResult> {
    const url = this.endpoint('/hcx/abha/biometric/auth/verify');
    if (!url) {
      return { status: 'failed', error: 'BIOMETRIC_AUTH_BASE_URL is not configured' };
    }
    const authMethod = authMethodFor(input.authMode);
    const body = {
      scope: ['abha-login', input.scope],
      authData: {
        authMethods: [authMethod],
        // Only include the field that matches the auth method. ABDM
        // rejects calls with multiple PID blocks set.
        ...(authMethod === 'bio'
          ? {
              bio: {
                txnId: input.authData.txnId,
                fingerPrintAuthPid: input.authData.fingerPrintAuthPid,
              },
            }
          : authMethod === 'face'
            ? {
                face: {
                  txnId: input.authData.txnId,
                  faceAuthPid: input.authData.faceAuthPid,
                },
              }
            : {
                iris: {
                  txnId: input.authData.txnId,
                  irisAuthPid: input.authData.irisAuthPid,
                },
              }),
      },
      authMode: input.authMode,
    };
    const result = await this.postJson(url, body, {
      Authorization: `Bearer ${input.bearerToken}`,
      process: input.process,
      payerid: input.payerId,
    });
    if (result.kind === 'error') {
      return { status: 'failed', error: result.error };
    }
    const obj = result.body as Record<string, unknown>;
    const authToken = typeof obj['token'] === 'string' ? (obj['token'] as string) : undefined;
    const refreshToken =
      typeof obj['refreshToken'] === 'string' ? (obj['refreshToken'] as string) : undefined;
    if (!authToken) {
      return {
        status: 'failed',
        error: 'ABDM verify response did not include a token',
      };
    }
    return {
      status: 'verified',
      authToken,
      ...(refreshToken !== undefined ? { refreshToken } : {}),
    };
  }

  async refreshToken(input: BiometricRefreshInput): Promise<BiometricRefreshResult> {
    const url = this.endpoint('/hcx/abha/biometric/auth/refresh/token');
    if (!url) {
      return { status: 'failed', error: 'BIOMETRIC_AUTH_BASE_URL is not configured' };
    }
    const result = await this.getJson(url, {
      Authorization: `Bearer ${input.bearerToken}`,
      'R-token': `Bearer ${input.refreshToken}`,
      process: input.process,
      payerid: input.payerId,
    });
    if (result.kind === 'error') {
      return { status: 'failed', error: result.error };
    }
    const obj = result.body as Record<string, unknown>;
    const authToken = typeof obj['token'] === 'string' ? (obj['token'] as string) : undefined;
    if (!authToken) {
      return {
        status: 'failed',
        error: 'ABDM refresh response did not include a token',
      };
    }
    return { status: 'refreshed', authToken };
  }

  private endpoint(path: string): string | null {
    const baseUrl = this.config.get('BIOMETRIC_AUTH_BASE_URL', { infer: true });
    if (!baseUrl) return null;
    return `${baseUrl.replace(/\/$/, '')}${path}`;
  }

  private async postJson(
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<HttpResult> {
    return this.call(url, 'POST', headers, JSON.stringify(body), 'application/json');
  }

  private async getJson(url: string, headers: Record<string, string>): Promise<HttpResult> {
    return this.call(url, 'GET', headers);
  }

  private async call(
    url: string,
    method: 'GET' | 'POST',
    headers: Record<string, string>,
    body?: string,
    contentType?: string,
  ): Promise<HttpResult> {
    const timeoutMs = this.config.get('BIOMETRIC_AUTH_HTTP_TIMEOUT_MS', { infer: true });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(contentType ? { 'content-type': contentType } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body } : {}),
        signal: ac.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`biometric-auth ${method} ${url} → network error: ${message}`);
      return { kind: 'error', error: `ABDM HTTP call failed: ${message}` };
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 500);
      return {
        kind: 'error',
        error: `ABDM returned HTTP ${res.status}${text ? `: ${text}` : ''}`,
      };
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { kind: 'error', error: `ABDM response is not valid JSON: ${message}` };
    }
    if (!parsed || typeof parsed !== 'object') {
      return { kind: 'error', error: 'ABDM response is not a JSON object' };
    }
    return { kind: 'ok', body: parsed };
  }
}

type HttpResult =
  | { kind: 'ok'; body: object }
  | { kind: 'error'; error: string };

function authMethodFor(mode: BiometricAuthMethodInput): 'bio' | 'face' | 'iris' {
  switch (mode) {
    case 'FINGERPRINT':
      return 'bio';
    case 'FACE_AUTH':
      return 'face';
    case 'IRIS':
      return 'iris';
  }
}

type BiometricAuthMethodInput = 'FINGERPRINT' | 'IRIS' | 'FACE_AUTH';
