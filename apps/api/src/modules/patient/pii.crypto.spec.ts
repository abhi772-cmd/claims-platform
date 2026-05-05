import { randomBytes } from 'node:crypto';

import {
  decryptString,
  deriveTenantKey,
  encryptString,
  lookupHash,
} from './pii.crypto';

describe('PII crypto', () => {
  describe('deriveTenantKey', () => {
    it('produces a 32-byte key', () => {
      const root = randomBytes(32);
      const key = deriveTenantKey(root, 'tenant-1');
      expect(key.length).toBe(32);
    });

    it('produces different keys for different tenants', () => {
      const root = randomBytes(32);
      const a = deriveTenantKey(root, 'tenant-1');
      const b = deriveTenantKey(root, 'tenant-2');
      expect(a.equals(b)).toBe(false);
    });

    it('is deterministic for the same (root, tenantId)', () => {
      const root = randomBytes(32);
      const a = deriveTenantKey(root, 'tenant-1');
      const b = deriveTenantKey(root, 'tenant-1');
      expect(a.equals(b)).toBe(true);
    });

    it('rejects a root key that is not 32 bytes', () => {
      expect(() => deriveTenantKey(randomBytes(16), 't')).toThrow(/32 bytes/);
    });
  });

  describe('encrypt/decrypt round-trip', () => {
    it('round-trips Aadhaar-shaped strings', () => {
      const root = randomBytes(32);
      const key = deriveTenantKey(root, 'tenant-1');
      const blob = encryptString('123412341234', key, 'v1');
      expect(blob.keyVersion).toBe('v1');
      expect(blob.cipher).not.toContain('123412341234');
      const back = decryptString(blob.cipher, key);
      expect(back).toBe('123412341234');
    });

    it('produces different ciphertext on each encryption (fresh IV)', () => {
      const key = deriveTenantKey(randomBytes(32), 't');
      const a = encryptString('hello', key, 'v1');
      const b = encryptString('hello', key, 'v1');
      expect(a.cipher).not.toBe(b.cipher);
    });

    it('decrypt with the wrong tenant key fails (auth tag mismatch)', () => {
      const root = randomBytes(32);
      const k1 = deriveTenantKey(root, 'tenant-1');
      const k2 = deriveTenantKey(root, 'tenant-2');
      const blob = encryptString('secret', k1, 'v1');
      expect(() => decryptString(blob.cipher, k2)).toThrow();
    });

    it('decrypt of tampered ciphertext fails', () => {
      const key = deriveTenantKey(randomBytes(32), 't');
      const blob = encryptString('secret', key, 'v1');
      // Flip the last byte (auth tag) — must reject.
      const buf = Buffer.from(blob.cipher, 'base64');
      buf[buf.length - 1] = (buf[buf.length - 1] ?? 0) ^ 0xff;
      const tampered = buf.toString('base64');
      expect(() => decryptString(tampered, key)).toThrow();
    });
  });

  describe('lookupHash', () => {
    it('is deterministic for the same input', () => {
      expect(lookupHash('123412341234')).toBe(lookupHash('123412341234'));
    });

    it('normalizes whitespace + case', () => {
      expect(lookupHash('  abc@example.com  ')).toBe(lookupHash('ABC@EXAMPLE.COM'));
    });

    it('produces a 64-char hex string', () => {
      const h = lookupHash('123412341234');
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    });

    it('different inputs produce different hashes', () => {
      expect(lookupHash('a')).not.toBe(lookupHash('b'));
    });
  });
});
