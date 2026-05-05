import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  type HprAdapter,
  type HprOtpRequestResult,
  type HprVerification,
} from './hpr-adapter.interface';
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

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async requestOtp(hprId: string): Promise<HprOtpRequestResult> {
    const baseUrl = this.required('ABDM_BASE_URL');
    const access = await this.fetchAccessToken();
    const res = await this.httpJson<AbdmInitResponse>('POST', `${baseUrl}/api/v1/auth/init`, {
      headers: { authorization: `Bearer ${access}` },
      body: {
        authMethod: 'MOBILE_OTP',
        // ABDM accepts the full HPR address (e.g. 12.34.5678910@hpr.abdm)
        // in `id`. Callers pass the full id; the adapter doesn't transform.
        id: hprId,
      },
    });
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
      const confirm = await this.httpJson<AbdmConfirmResponse>(
        'POST',
        `${baseUrl}/api/v1/auth/confirmWithMobileOTP`,
        {
          headers: { authorization: `Bearer ${access}` },
          body: { otp: input.otp, txnId: input.transactionId },
        },
      );
      xToken = confirm.token;
    } catch (err) {
      this.log.warn(`hpr confirm failed hprId=${input.hprId}: ${describeErr(err)}`);
      throw new HprVerificationFailedError();
    }

    let profile: AbdmProfileResponse;
    try {
      profile = await this.httpJson<AbdmProfileResponse>(
        'GET',
        `${baseUrl}/api/v2/hpr/healthcareprofessional/${encodeURIComponent(input.hprId)}`,
        {
          headers: {
            authorization: `Bearer ${access}`,
            'x-token': `Bearer ${xToken}`,
          },
        },
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

  private async fetchAccessToken(): Promise<string> {
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
    return res.accessToken;
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
        throw new Error(`ABDM ${method} ${url} → HTTP ${res.status} ${body.slice(0, 200)}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
