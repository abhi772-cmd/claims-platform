// Slice BF — Stub biometric auth adapter. Bound when
// BIOMETRIC_AUTH_MODE='stub'. Deterministic in-process simulation of
// the ABDM three-call dance, used by integration tests that drive
// the "PMJAY case can't move past preauth without a verified
// biometric" flow without an ABDM sandbox account.
//
// Behaviour:
//   * `init` returns `{ status: 'init_ok', txnId: <stub-uuid> }`
//     unless the loginId appears in BIOMETRIC_AUTH_STUB_FAIL_LIST,
//     in which case it returns `{ status: 'failed' }` so negative
//     paths can be exercised.
//   * `verify` returns `{ status: 'verified', authToken, refreshToken }`
//     when the txnId came from a prior init (we hold a small in-memory
//     map). Mismatched / unknown txnIds → 'failed' with a message
//     mirroring what ABDM returns for the same case. Loosely shaped
//     auth tokens (`stub-auth-<txnId>`, `stub-refresh-<txnId>`) so
//     downstream tests can assert on them.
//   * `refreshToken` swaps a refresh handle for a fresh authToken,
//     rejecting unknown handles with 'failed'.
//
// The stub does not validate the PID block — that's a device-level
// concern. The whole point is to exercise our gate logic, not the
// biometric-capture device.

import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
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
export class StubBiometricAuthAdapter implements BiometricAuthAdapter {
  // txnId → loginId, so verify() can confirm the txn came from us.
  // Bounded by the lifetime of the process; integration tests don't
  // need persistence and this stub never runs in production.
  private readonly initiated = new Map<string, string>();
  // refreshToken → loginId, used by refreshToken() to mint a fresh
  // authToken without going back through init/verify.
  private readonly refreshes = new Map<string, string>();

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async init(input: BiometricInitInput): Promise<BiometricInitResult> {
    if (this.isFailingLogin(input.loginId)) {
      return {
        status: 'failed',
        error: 'Stub: loginId is on BIOMETRIC_AUTH_STUB_FAIL_LIST',
      };
    }
    const txnId = randomUUID();
    this.initiated.set(txnId, input.loginId);
    return { status: 'init_ok', txnId };
  }

  async verify(input: BiometricVerifyInput): Promise<BiometricVerifyResult> {
    const loginId = this.initiated.get(input.authData.txnId);
    if (!loginId) {
      return {
        status: 'failed',
        error: `Stub: txnId ${input.authData.txnId} was not initiated`,
      };
    }
    // One-shot — drop the txn so a replay fails. Real ABDM has
    // server-side idempotency on this; we just mimic the observable
    // behaviour.
    this.initiated.delete(input.authData.txnId);
    const authToken = `stub-auth-${input.authData.txnId}`;
    const refreshToken = `stub-refresh-${input.authData.txnId}`;
    this.refreshes.set(refreshToken, loginId);
    return { status: 'verified', authToken, refreshToken };
  }

  async refreshToken(input: BiometricRefreshInput): Promise<BiometricRefreshResult> {
    const loginId = this.refreshes.get(input.refreshToken);
    if (!loginId) {
      return {
        status: 'failed',
        error: `Stub: unknown refresh token`,
      };
    }
    return { status: 'refreshed', authToken: `stub-auth-refreshed-${loginId}` };
  }

  private isFailingLogin(loginId: string): boolean {
    const raw = this.config.get('BIOMETRIC_AUTH_STUB_FAIL_LIST', { infer: true }) ?? '';
    if (!raw) return false;
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(loginId);
  }
}
