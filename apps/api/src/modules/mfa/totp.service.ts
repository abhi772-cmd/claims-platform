import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { authenticator, hotp } from 'otplib';
import { toDataURL } from 'qrcode';

import { type AppConfig } from '../../config/configuration';

// Standard TOTP settings matching Google Authenticator's defaults so codes
// from any common Authenticator app validate against this server:
//   digits = 6, step = 30s, algorithm = SHA1, window = ±1 step.
// We then enforce no replay within the same step via lastUsedStep on the
// enrollment row, so the ±1 window only buys leniency at rotation
// boundaries — not free re-use.
authenticator.options = {
  digits: 6,
  step: 30,
  window: 1,
  algorithm: 'sha1' as never,
};
hotp.options = {
  digits: 6,
  algorithm: 'sha1' as never,
};

export interface SetupArtifacts {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

@Injectable()
export class TotpService {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  generateSecret(): string {
    return authenticator.generateSecret();
  }

  buildOtpauthUrl(secret: string, accountEmail: string): string {
    return authenticator.keyuri(accountEmail, this.issuer(), secret);
  }

  async buildQrDataUrl(otpauthUrl: string): Promise<string> {
    return toDataURL(otpauthUrl, { errorCorrectionLevel: 'M', margin: 1 });
  }

  async generateSetup(accountEmail: string): Promise<SetupArtifacts> {
    const secret = this.generateSecret();
    const otpauthUrl = this.buildOtpauthUrl(secret, accountEmail);
    const qrDataUrl = await this.buildQrDataUrl(otpauthUrl);
    return { secret, otpauthUrl, qrDataUrl };
  }

  // Validate a 6-digit code against the secret. Returns the matching step
  // (so the caller can persist lastUsedStep and reject same-step replays),
  // or null on mismatch / malformed input.
  verifyAndGetStep(code: string, secret: string): number | null {
    if (!/^[0-9]{6}$/.test(code)) return null;
    const currentStep = this.currentStep();
    for (const offset of [0, -1, 1]) {
      const step = currentStep + offset;
      if (hotp.generate(secret, step) === code) return step;
    }
    return null;
  }

  generateAt(secret: string, step: number): string {
    return hotp.generate(secret, step);
  }

  currentStep(): number {
    return Math.floor(Date.now() / 1000 / 30);
  }

  private issuer(): string {
    return this.config.get('JWT_ISSUER', { infer: true }) ?? 'DigiSparsh Claims';
  }
}
