// Slice AP — unit coverage for the comms-secret KMS-wrap helpers.
//
// Asserts the round-trip works, that the on-disk format carries the
// `kms:v1:` prefix (so readers can distinguish wrapped from legacy
// plaintext), and that wrong tenant / wrong root key fail closed.

import { randomBytes } from 'node:crypto';

import {
  deriveCommsTenantKey,
  isWrapped,
  unwrapSecret,
  wrapSecret,
} from './comms-secret.crypto';
import { deriveTenantKey } from '../patient/pii.crypto';

describe('comms-secret crypto', () => {
  const rootKey = randomBytes(32);
  const tenantA = '11111111-2222-3333-4444-555555555555';
  const tenantB = '99999999-8888-7777-6666-555555555555';

  it('wraps and unwraps a secret round-trip', () => {
    const key = deriveCommsTenantKey(rootKey, tenantA);
    const wrapped = wrapSecret('hunter2', key);
    expect(isWrapped(wrapped)).toBe(true);
    expect(wrapped.startsWith('kms:v1:')).toBe(true);
    expect(wrapped).not.toContain('hunter2');
    expect(unwrapSecret(wrapped, key)).toBe('hunter2');
  });

  it('produces different ciphertext for the same plaintext on each call (random IV)', () => {
    const key = deriveCommsTenantKey(rootKey, tenantA);
    const a = wrapSecret('same-plaintext', key);
    const b = wrapSecret('same-plaintext', key);
    expect(a).not.toBe(b);
  });

  it('decryption with the wrong tenant key fails closed', () => {
    const keyA = deriveCommsTenantKey(rootKey, tenantA);
    const keyB = deriveCommsTenantKey(rootKey, tenantB);
    const wrapped = wrapSecret('shh', keyA);
    expect(() => unwrapSecret(wrapped, keyB)).toThrow();
  });

  it('decryption with a different root key fails closed', () => {
    const keyA = deriveCommsTenantKey(rootKey, tenantA);
    const wrapped = wrapSecret('shh', keyA);
    const otherRoot = randomBytes(32);
    const wrongKey = deriveCommsTenantKey(otherRoot, tenantA);
    expect(() => unwrapSecret(wrapped, wrongKey)).toThrow();
  });

  it('isWrapped returns false for legacy plaintext values', () => {
    expect(isWrapped('plaintext-from-before-AP')).toBe(false);
    expect(isWrapped('')).toBe(false);
  });

  it('unwrapSecret passes through legacy plaintext (back-compat for pre-AP rows)', () => {
    const key = deriveCommsTenantKey(rootKey, tenantA);
    expect(unwrapSecret('legacy-plaintext', key)).toBe('legacy-plaintext');
  });

  it('comms-derived key differs from PII-derived key (salt namespacing)', () => {
    // Same root + tenant, but the comms HKDF salt is 'digisparsh-comms-v1'
    // while pii.crypto's is 'digisparsh-pii-v1' — so the derived keys
    // must NOT be byte-equal, otherwise we've lost the cross-domain
    // blast-radius isolation.
    const commsKey = deriveCommsTenantKey(rootKey, tenantA);
    const piiKey = deriveTenantKey(rootKey, tenantA);
    expect(commsKey.equals(piiKey)).toBe(false);
  });

  it('rejects a root key of the wrong length', () => {
    expect(() => deriveCommsTenantKey(randomBytes(16), tenantA)).toThrow(/32 bytes/);
    expect(() => deriveCommsTenantKey(randomBytes(64), tenantA)).toThrow(/32 bytes/);
  });
});
