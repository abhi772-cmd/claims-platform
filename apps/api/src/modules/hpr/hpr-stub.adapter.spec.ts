import { type ConfigService } from '@nestjs/config';

import { HprStubAdapter } from './hpr-stub.adapter';
import { HprVerificationFailedError } from '../../common/errors/auth-errors';

const cfg = (values: Record<string, unknown>): ConfigService =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

describe('HprStubAdapter', () => {
  let adapter: HprStubAdapter;

  beforeEach(() => {
    adapter = new HprStubAdapter(
      cfg({
        HPR_STUB_ALLOWLIST: '12345678901234,99999999999999',
        HPR_STUB_OTP: '654321',
      }) as never,
    );
  });

  describe('requestOtp', () => {
    it('returns a synthetic transactionId for an allowlisted HPR', async () => {
      const out = await adapter.requestOtp('12345678901234');
      expect(out.transactionId).toMatch(/^stub-tx-[0-9a-f-]{36}$/);
      expect(new Date(out.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('rejects HPR ids not in the allowlist', async () => {
      await expect(adapter.requestOtp('00000000000000')).rejects.toBeInstanceOf(
        HprVerificationFailedError,
      );
    });
  });

  describe('verifyOtp', () => {
    it('returns a synthetic profile when allowlist + OTP match', async () => {
      const out = await adapter.verifyOtp({ hprId: '12345678901234', otp: '654321' });
      expect(out.hprId).toBe('12345678901234');
      expect(out.fullName).toBe('Dr. HPR-1234');
      expect(out.registrationActive).toBe(true);
    });

    it('rejects when OTP does not match the configured stub OTP', async () => {
      await expect(
        adapter.verifyOtp({ hprId: '12345678901234', otp: '111111' }),
      ).rejects.toBeInstanceOf(HprVerificationFailedError);
    });

    it('rejects when HPR id is not in allowlist regardless of OTP', async () => {
      await expect(
        adapter.verifyOtp({ hprId: '00000000000000', otp: '654321' }),
      ).rejects.toBeInstanceOf(HprVerificationFailedError);
    });

    it('ignores transactionId — stub does not link OTPs to txns', async () => {
      const out = await adapter.verifyOtp({
        hprId: '12345678901234',
        otp: '654321',
        transactionId: 'irrelevant',
      });
      expect(out.hprId).toBe('12345678901234');
    });
  });
});
