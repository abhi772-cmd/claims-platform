// Resolves the right NHCX private key for an inbound JWE blob based on
// its `kid` header. Supports a rolling rotation: at any given time we
// have at most ONE active key (the one we sign+encrypt outbound with)
// and zero-or-more retired keys still able to decrypt inbound while
// NHCX-side has not yet caught up to the new public key.
//
// The map is keyed on the version string ("v1", "v2", …). Outbound
// always uses the active version; the resolver picks the version
// stamped in the inbound JWE protected header.
//
// Rotation steps:
//   1. Generate a new keypair, give NHCX the public half.
//   2. Set NHCX_PRIVATE_KEY_BASE64_V2 + keep the old NHCX_PRIVATE_KEY_
//      BASE64 in place. Both decrypt; outbound still uses v1.
//   3. Once NHCX confirms cutover, flip NHCX_PRIVATE_KEY_VERSION=v2
//      and move the v2 PEM into NHCX_PRIVATE_KEY_BASE64. Drop
//      NHCX_PRIVATE_KEY_BASE64_V2.

import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { type AppConfig } from '../../config/configuration';

export const NHCX_KEY_RESOLVER = Symbol('NHCX_KEY_RESOLVER');

export interface NhcxKeyResolver {
  // The PEM string used for outbound encryption + signing. May throw
  // if real-mode wiring is incomplete.
  activePrivateKey(): { pem: string; version: string };
  // Look up a private key by `kid` (version string). Returns null when
  // the version isn't known — the caller decides whether to surface as
  // an error or trigger a key reload.
  privateKeyForVersion(version: string): string | null;
}

@Injectable()
export class EnvKeyResolver implements NhcxKeyResolver {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  activePrivateKey(): { pem: string; version: string } {
    const version = this.config.get('NHCX_PRIVATE_KEY_VERSION', { infer: true });
    const pem = this.privateKeyForVersion(version);
    if (!pem) {
      throw new Error(
        `NHCX active private key version=${version} is not configured — set NHCX_PRIVATE_KEY_BASE64 (for v1) or NHCX_PRIVATE_KEY_BASE64_V2 (for v2).`,
      );
    }
    return { pem, version };
  }

  privateKeyForVersion(version: string): string | null {
    // v1 maps to the legacy NHCX_PRIVATE_KEY_BASE64 slot; v2 to the
    // explicit _V2 slot. New versions land here as we ship them.
    if (version === 'v1') return this.config.get('nhcxPrivateKeyPem', { infer: true });
    if (version === 'v2') return this.config.get('nhcxPrivateKeyPemV2', { infer: true });
    return null;
  }
}

// Helper export so callers don't have to fish through @Inject decorators.
export const NhcxKeyResolverProvider = {
  provide: NHCX_KEY_RESOLVER,
  inject: [EnvKeyResolver],
  useFactory: (resolver: EnvKeyResolver): NhcxKeyResolver => resolver,
};

// re-export so tests can grab the inject token in DI overrides.
export { Inject };
