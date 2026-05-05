import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  type HprAdapter,
  type HprOtpRequestResult,
  type HprVerification,
} from './hpr-adapter.interface';
import { TokenCache } from './token-cache';
import { HprVerificationFailedError } from '../../common/errors/auth-errors';
import { type AppConfig } from '../../config/configuration';

// Real ABDM HPR adapter. Talks to:
//   1. POST  /gateway/v0.5/sessions                           → access token
//      (client_credentials grant)
//   2. POST  /api/v1/auth/init                                → transactionId
//      (sends OTP to the doctor's registered mobile)
//   3. POST  /api/v1/auth/confirmWithMobileOTP                → x-token
//   4. GET   /api/v2/hpr/healthcareprofessional/{hprId}       → profile
//
// We deliberately don't cache the access token across requests in V1
// — every flow fetches a fresh one. ABDM access tokens are short-lived
// and the doctor-sign volume is low (handful per claim, days apart),
// so the extra latency is acceptable. Sprint 3 hardening: add a
// process-level token cache with refresh-on-401.

interface AbdmTokenResponse {
  accessToken: string;
  expiresIn?: number;
}

interface AbdmInitResponse {
  txnId: string;
  // ABDM may return additional fields; only txnId is load-bearing.
}

interface AbdmConfirmResponse {
  // ABDM returns a short-lived bearer token tied to this txn — used to
  // call subsequent profile endpoints. We don't need to surface it; the
  // adapter consumes it inline.
  token: string;
}

interface AbdmProfileResponse {
  hprId: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  // ABDM uses a string status field; treat any value other than the
  // documented "active" / "Active" as inactive.
  registrationStatus?: string;
}

@Injectable()
export class HprRealAdapter implements HprAdapter {
  private readonly log = new Logger(HprRealAdapter.name);
  // Single shared cache keyed on (clientId, baseUrl). Reuse across
  // every doctor-sign request prevents the per-call token round-trip
  // and absorbs the thundering-herd at expiry.
  private readonly tokenCache = new TokenCache();

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async requestOtp(hprId: string): Promise<HprOtpRequestResult> {
    const baseUrl = this.required('ABDM_BASE_URL');
    const access = await this.fetchAccessToken();
    const res = await this.httpJsonWith401Retry<AbdmInitResponse>(
      'POST',
      `${baseUrl}/api/v1/auth/init`,
      (token) => ({
        headers: { authorization: `Bearer ${token}` },
        body: {
          authMethod: 'MOBILE_OTP',
          // ABDM accepts the full HPR address (e.g. 12.34.5678910@hpr.abdm)
          // in `id`. Callers pass the full id; the adapter doesn't transform.
          id: hprId,
        },
      }),
      access,
    );
    return {
      transactionId: res.txnId,
      // ABDM OTPs typically live ~5 minutes; we don't get an explicit
      // expiry back, so we synthesise.
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
  }

  async verifyOtp(input: {
    hprId: string;
    otp: string;
    transactionId?: string;
  }): Promise<HprVerification> {
    if (!input.transactionId) {
      this.log.warn('hpr real verifyOtp called without transactionId');
      throw new HprVerificationFailedError();
    }
    const baseUrl = this.required('ABDM_BASE_URL');
    const access = await this.fetchAccessToken();

    let xToken: string;
    try {
      const confirm = await this.httpJsonWith401Retry<AbdmConfirmResponse>(
        'POST',
        `${baseUrl}/api/v1/auth/confirmWithMobileOTP`,
        (token) => ({
          headers: { authorization: `Bearer ${token}` },
          body: { otp: input.otp, txnId: input.transactionId },
        }),
        access,
      );
      xToken = confirm.token;
    } catch (err) {
      this.log.warn(`hpr confirm failed hprId=${input.hprId}: ${describeErr(err)}`);
      throw new HprVerificationFailedError();
    }

    let profile: AbdmProfileResponse;
    try {
      profile = await this.httpJsonWith401Retry<AbdmProfileResponse>(
        'GET',
        `${baseUrl}/api/v2/hpr/healthcareprofessional/${encodeURIComponent(input.hprId)}`,
        (token) => ({
          headers: {
            authorization: `Bearer ${token}`,
            'x-token': `Bearer ${xToken}`,
          },
        }),
        access,
      );
    } catch (err) {
      this.log.warn(`hpr profile lookup failed hprId=${input.hprId}: ${describeErr(err)}`);
      throw new HprVerificationFailedError();
    }

    const fullName =
      profile.fullName ??
      ([profile.firstName, profile.lastName].filter(Boolean).join(' ').trim() ||
        input.hprId);
    const registrationActive =
      (profile.registrationStatus ?? '').toLowerCase() === 'active';
    return {
      hprId: profile.hprId || input.hprId,
      fullName,
      registrationActive,
    };
  }

  // -------------- internals ------------------------------------

  private required(key: 'ABDM_BASE_URL' | 'ABDM_CLIENT_ID' | 'ABDM_CLIENT_SECRET'): string {
    const value = this.config.get(key, { infer: true });
    if (!value) {
      throw new Error(`HprRealAdapter missing config ${key} — config loader should have rejected.`);
    }
    return value;
  }

  // Cache key combines baseUrl + clientId so a config change at runtime
  // (e.g. blue/green clientId rotation) doesn't accidentally serve the
  // stale token. Different ABDM gateway tiers (sandbox vs prod) get
  // separate entries.
  private cacheKey(): string {
    const baseUrl = this.config.get('ABDM_BASE_URL', { infer: true }) ?? '';
    const clientId = this.config.get('ABDM_CLIENT_ID', { infer: true }) ?? '';
    return `${baseUrl}|${clientId}`;
  }

  private async fetchAccessToken(): Promise<string> {
    return this.tokenCache.get(this.cacheKey(), async () => {
      const baseUrl = this.required('ABDM_BASE_URL');
      const clientId = this.required('ABDM_CLIENT_ID');
      const clientSecret = this.required('ABDM_CLIENT_SECRET');
      const res = await this.httpJson<AbdmTokenResponse>(
        'POST',
        `${baseUrl}/gateway/v0.5/sessions`,
        {
          body: {
            clientId,
            clientSecret,
            grantType: 'client_credentials',
          },
        },
      );
      if (!res.accessToken) {
        throw new Error('ABDM token response missing accessToken.');
      }
      // ABDM doesn't always return expiresIn; default to 25 minutes
      // (a touch under the documented 30 min) so we refresh ahead.
      const ttlSeconds = res.expiresIn ?? 25 * 60;
      return { token: res.accessToken, ttlSeconds };
    });
  }

  // Invalidate + retry once. Used after a 401 from any downstream call
  // — ABDM may have rotated the gateway secret on us, in which case
  // the next mint succeeds.
  private async fetchAccessTokenAfterInvalidate(): Promise<string> {
    this.tokenCache.invalidate(this.cacheKey());
    return this.fetchAccessToken();
  }

  private async httpJson<T>(
    method: 'GET' | 'POST',
    url: string,
    init: { headers?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    const timeoutMs = this.config.get('ABDM_HTTP_TIMEOUT_MS', { infer: true });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...init.headers,
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: ac.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(
          `ABDM ${method} ${url} → HTTP ${res.status} ${body.slice(0, 200)}`,
        );
        // Tag the error so callers can match on 401 without parsing
        // the message. Simpler than throwing a custom subclass that the
        // verifyOtp path would also have to import.
        (err as { httpStatus?: number }).httpStatus = res.status;
        throw err;
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // Same as httpJson but on 401 invalidates the cached access token,
  // re-fetches a fresh one, and retries the call once with the new
  // bearer in the Authorization header. Returns the original error if
  // the retry also fails. The caller passes a builder closure so we
  // can substitute the bearer at retry time.
  private async httpJsonWith401Retry<T>(
    method: 'GET' | 'POST',
    url: string,
    buildInit: (token: string) => {
      headers?: Record<string, string>;
      body?: unknown;
    },
    initialToken: string,
  ): Promise<T> {
    try {
      return await this.httpJson<T>(method, url, buildInit(initialToken));
    } catch (err) {
      if ((err as { httpStatus?: number }).httpStatus !== 401) throw err;
      this.log.warn(`ABDM ${url} returned 401 — refreshing token and retrying once`);
      const fresh = await this.fetchAccessTokenAfterInvalidate();
      return this.httpJson<T>(method, url, buildInit(fresh));
    }
  }
}

function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
