import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { HprVerificationFailedError } from '../../common/errors/auth-errors';
import { type AppConfig } from '../../config/configuration';

export interface HprVerification {
  hprId: string;
  fullName: string;
  registrationActive: boolean;
}

// V1 stub. The real verification calls ABDM's HPR API and consumes an
// SMS OTP they issue against the registered mobile. We don't have an
// ABDM connection in this sprint, so we accept HPR ids from a configured
// allowlist plus a fixed OTP (HPR_STUB_OTP). The shape of the API matches
// the eventual real adapter so the only thing that changes when we
// integrate is the implementation here.
@Injectable()
export class HprService {
  private readonly log = new Logger(HprService.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  // Verify an HPR id + OTP. Throws HprVerificationFailedError on any
  // failure (don't leak which one — the doctor-token guard already
  // ensured this is the right doctor; we don't need to differentiate
  // "wrong otp" from "wrong hpr" for the caller).
  async verify(hprId: string, otp: string): Promise<HprVerification> {
    const allowlist = this.parseAllowlist();
    const expectedOtp = this.config.get('HPR_STUB_OTP', { infer: true });
    if (!allowlist.has(hprId)) {
      this.log.warn(`hpr verification failed (id not in allowlist) hprId=${hprId}`);
      throw new HprVerificationFailedError();
    }
    if (otp !== expectedOtp) {
      this.log.warn(`hpr verification failed (otp mismatch) hprId=${hprId}`);
      throw new HprVerificationFailedError();
    }
    // Stub: synthesise a name from the HPR id. The real API returns the
    // doctor's name from the ABDM registry; we keep that contract here
    // so calling code doesn't have to change later.
    return {
      hprId,
      fullName: `Dr. HPR-${hprId.slice(-4)}`,
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
