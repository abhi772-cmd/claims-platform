import { type ConfigService } from '@nestjs/config';

import { EnvKeyResolver } from './nhcx-key-resolver';

const cfg = (values: Record<string, unknown>): ConfigService =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

describe('EnvKeyResolver', () => {
  it('returns the v1 PEM when NHCX_PRIVATE_KEY_VERSION=v1', () => {
    const resolver = new EnvKeyResolver(
      cfg({
        NHCX_PRIVATE_KEY_VERSION: 'v1',
        nhcxPrivateKeyPem: '---PEM-V1---',
        nhcxPrivateKeyPemV2: '---PEM-V2---',
      }) as never,
    );
    const out = resolver.activePrivateKey();
    expect(out.version).toBe('v1');
    expect(out.pem).toBe('---PEM-V1---');
  });

  it('returns the v2 PEM when NHCX_PRIVATE_KEY_VERSION=v2', () => {
    const resolver = new EnvKeyResolver(
      cfg({
        NHCX_PRIVATE_KEY_VERSION: 'v2',
        nhcxPrivateKeyPem: '---PEM-V1---',
        nhcxPrivateKeyPemV2: '---PEM-V2---',
      }) as never,
    );
    const out = resolver.activePrivateKey();
    expect(out.version).toBe('v2');
    expect(out.pem).toBe('---PEM-V2---');
  });

  it('throws when the active version has no configured PEM', () => {
    const resolver = new EnvKeyResolver(
      cfg({
        NHCX_PRIVATE_KEY_VERSION: 'v2',
        nhcxPrivateKeyPem: '---PEM-V1---',
        nhcxPrivateKeyPemV2: null,
      }) as never,
    );
    expect(() => resolver.activePrivateKey()).toThrow(/v2/);
  });

  it('looks up retired versions for inbound decryption', () => {
    // Active=v2; v1 is retired but still reachable via the resolver
    // so inbound JWEs addressed to v1 keep decrypting through the
    // rotation window.
    const resolver = new EnvKeyResolver(
      cfg({
        NHCX_PRIVATE_KEY_VERSION: 'v2',
        nhcxPrivateKeyPem: '---PEM-V1---',
        nhcxPrivateKeyPemV2: '---PEM-V2---',
      }) as never,
    );
    expect(resolver.privateKeyForVersion('v1')).toBe('---PEM-V1---');
    expect(resolver.privateKeyForVersion('v2')).toBe('---PEM-V2---');
    expect(resolver.privateKeyForVersion('v99')).toBeNull();
  });
});
