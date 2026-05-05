import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  type HprAdapter,
  type HprOtpRequestResult,
  type HprVerification,
} from './hpr-adapter.interface';
import { HprVerificationFailedError } from '../../common/errors/auth-errors';
import { type AppConfig } from '../../config/configuration';

// Stub: HPR_STUB_ALLOWLIST + HPR_STUB_OTP gate verification. requestOtp
// is a no-op that mints a synthetic transactionId. The stub deliberately
// ignores transactionId on verify — historical doctor-sign tests pass a
// raw OTP without going through requestOtp first.
@Injectable()
export class HprStubAdapter implements HprAdapter {
  private readonly log = new Logger(HprStubAdapter.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async requestOtp(hprId: string): Promise<HprOtpRequestResult> {
    // Verifying the HPR is in the allowlist at this stage too — gives
    // the UI a fast "no such HPR" before the doctor types the OTP.
    const allowlist = this.parseAllowlist();
    if (!allowlist.has(hprId)) {
      this.log.warn(`hpr stub init rejected (id not in allowlist) hprId=${hprId}`);
      throw new HprVerificationFailedError();
    }
    return {
      transactionId: `stub-tx-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
  }

  async verifyOtp(input: {
    hprId: string;
    otp: string;
    transactionId?: string;
  }): Promise<HprVerification> {
    const allowlist = this.parseAllowlist();
    const expectedOtp = this.config.get('HPR_STUB_OTP', { infer: true });
    if (!allowlist.has(input.hprId)) {
      this.log.warn(`hpr verification failed (id not in allowlist) hprId=${input.hprId}`);
      throw new HprVerificationFailedError();
    }
    if (input.otp !== expectedOtp) {
      this.log.warn(`hpr verification failed (otp mismatch) hprId=${input.hprId}`);
      throw new HprVerificationFailedError();
    }
    return {
      hprId: input.hprId,
      fullName: `Dr. HPR-${input.hprId.slice(-4)}`,
      registrationActive: true,
    };
  }

  private parseAllowlist(): ReadonlySet<string> {
    const raw = this.config.get('HPR_STUB_ALLOWLIST', { infer: true });
    if (!raw) return new Set();
    return new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
  }
}
