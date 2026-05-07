// Slice BF — unit coverage for the disabled + stub biometric auth
// adapters. The HTTP adapter has its own spec that drives a node:http
// mock.

import { type ConfigService } from '@nestjs/config';

import {
  type BiometricInitInput,
  type BiometricVerifyInput,
} from './biometric-auth-adapter.interface';
import { DisabledBiometricAuthAdapter } from './disabled-biometric-auth.adapter';
import { StubBiometricAuthAdapter } from './stub-biometric-auth.adapter';
import { type AppConfig } from '../../config/configuration';

function makeConfig(failList = ''): ConfigService<AppConfig, true> {
  return {
    get(key: string): unknown {
      if (key === 'BIOMETRIC_AUTH_STUB_FAIL_LIST') return failList;
      return undefined;
    },
  } as unknown as ConfigService<AppConfig, true>;
}

const baseInit: BiometricInitInput = {
  scope: 'aadhaar-bio-verify',
  loginHint: 'abha-number',
  loginId: '91-1234-5678-0001',
  authMode: 'FINGERPRINT',
  process: 'Preauth',
  payerId: '123@hcx',
  bearerToken: 'platform-jwt',
};

describe('DisabledBiometricAuthAdapter', () => {
  it('returns disabled for every operation', async () => {
    const a = new DisabledBiometricAuthAdapter();
    expect(await a.init()).toEqual({ status: 'disabled' });
    expect(await a.verify()).toEqual({ status: 'disabled' });
    expect(await a.refreshToken()).toEqual({ status: 'disabled' });
  });
});

describe('StubBiometricAuthAdapter', () => {
  it('init → init_ok with a fresh txnId', async () => {
    const a = new StubBiometricAuthAdapter(makeConfig());
    const r1 = await a.init(baseInit);
    expect(r1.status).toBe('init_ok');
    expect(typeof r1.txnId).toBe('string');
    const r2 = await a.init(baseInit);
    expect(r2.status).toBe('init_ok');
    expect(r2.txnId).not.toBe(r1.txnId);
  });

  it('init → failed when loginId is on the fail list', async () => {
    const a = new StubBiometricAuthAdapter(makeConfig('91-1234-5678-0001, 91-9999-9999-9999'));
    const r = await a.init(baseInit);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/BIOMETRIC_AUTH_STUB_FAIL_LIST/);
  });

  it('verify of an init txnId → verified with auth + refresh tokens', async () => {
    const a = new StubBiometricAuthAdapter(makeConfig());
    const init = await a.init(baseInit);
    const verifyInput: BiometricVerifyInput = {
      scope: 'aadhaar-bio-verify',
      authMode: 'FINGERPRINT',
      authData: { txnId: init.txnId!, fingerPrintAuthPid: 'pid-block' },
      process: 'Preauth',
      payerId: '123@hcx',
      bearerToken: 'platform-jwt',
    };
    const v = await a.verify(verifyInput);
    expect(v.status).toBe('verified');
    expect(v.authToken).toBe(`stub-auth-${init.txnId}`);
    expect(v.refreshToken).toBe(`stub-refresh-${init.txnId}`);
  });

  it('verify replays the same txnId → second call fails', async () => {
    const a = new StubBiometricAuthAdapter(makeConfig());
    const init = await a.init(baseInit);
    const input: BiometricVerifyInput = {
      scope: 'aadhaar-bio-verify',
      authMode: 'FINGERPRINT',
      authData: { txnId: init.txnId!, fingerPrintAuthPid: 'pid-block' },
      process: 'Preauth',
      payerId: '123@hcx',
      bearerToken: 'platform-jwt',
    };
    const first = await a.verify(input);
    expect(first.status).toBe('verified');
    const second = await a.verify(input);
    expect(second.status).toBe('failed');
    expect(second.error).toMatch(/was not initiated/);
  });

  it('verify with unknown txnId → failed', async () => {
    const a = new StubBiometricAuthAdapter(makeConfig());
    const v = await a.verify({
      scope: 'aadhaar-bio-verify',
      authMode: 'FINGERPRINT',
      authData: { txnId: 'never-initiated', fingerPrintAuthPid: 'pid-block' },
      process: 'Preauth',
      payerId: '123@hcx',
      bearerToken: 'platform-jwt',
    });
    expect(v.status).toBe('failed');
  });

  it('refreshToken with a known refresh handle → refreshed with a fresh authToken', async () => {
    const a = new StubBiometricAuthAdapter(makeConfig());
    const init = await a.init(baseInit);
    const verified = await a.verify({
      scope: 'aadhaar-bio-verify',
      authMode: 'FINGERPRINT',
      authData: { txnId: init.txnId!, fingerPrintAuthPid: 'pid-block' },
      process: 'Preauth',
      payerId: '123@hcx',
      bearerToken: 'platform-jwt',
    });
    const r = await a.refreshToken({
      bearerToken: 'platform-jwt',
      refreshToken: verified.refreshToken!,
      process: 'Discharge',
      payerId: '123@hcx',
    });
    expect(r.status).toBe('refreshed');
    expect(r.authToken).toMatch(/^stub-auth-refreshed-/);
  });

  it('refreshToken with an unknown handle → failed', async () => {
    const a = new StubBiometricAuthAdapter(makeConfig());
    const r = await a.refreshToken({
      bearerToken: 'platform-jwt',
      refreshToken: 'nope',
      process: 'Discharge',
      payerId: '123@hcx',
    });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/unknown refresh token/);
  });

  it('FACE_AUTH and IRIS modes initiate cleanly the same way', async () => {
    const a = new StubBiometricAuthAdapter(makeConfig());
    const face = await a.init({ ...baseInit, scope: 'aadhaar-face-verify', authMode: 'FACE_AUTH' });
    const iris = await a.init({ ...baseInit, scope: 'aadhaar-iris-verify', authMode: 'IRIS' });
    expect(face.status).toBe('init_ok');
    expect(iris.status).toBe('init_ok');
    expect(face.txnId).not.toBe(iris.txnId);
  });
});
