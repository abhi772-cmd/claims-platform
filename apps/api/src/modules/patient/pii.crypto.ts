// Envelope encryption for patient PII.
//
// Sprint 2 ships a stub mode: a single base64 root key from env is
// used as the DEK directly. The full design (Sprint 5):
//   * Tenant onboarding generates a 32-byte DEK.
//   * The DEK is wrapped with the OVH KMS root key and the wrapped
//     bytes are stored on tenant.config.
//   * On request the wrapped bytes are unwrapped via KMS and cached
//     in process memory keyed on (tenantId, keyVersion). Rotation =
//     new keyVersion + new DEK + wrapped store + drain old version.
//
// For now everything goes through this module's encryptString +
// decryptString helpers and the keyVersion column on the row tracks
// which key produced the blob. When real KMS lands, callers don't
// change.

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface CipherBlob {
  cipher: string; // base64(iv || ciphertext || authTag)
  keyVersion: string;
}

// Derive a per-tenant 32-byte key from the root key + tenantId via
// HKDF-SHA256. The root key is the stub-mode equivalent of OVH KMS's
// CMK; per-tenant derivation gives blast-radius isolation if a single
// tenant's data is ever exfiltrated.
export function deriveTenantKey(rootKey: Buffer, tenantId: string): Buffer {
  if (rootKey.length !== 32) {
    throw new Error(`root key must be 32 bytes; got ${rootKey.length}`);
  }
  const salt = Buffer.from('digisparsh-pii-v1');
  const info = Buffer.from(`tenant:${tenantId}`);
  const out = hkdfSync('sha256', rootKey, salt, info, 32);
  return Buffer.from(out);
}

// Encrypt UTF-8 text. Returns a base64 blob and the keyVersion that
// produced it. `null` and `undefined` pass through — the caller decides
// whether the field is even present.
export function encryptString(
  plaintext: string,
  tenantKey: Buffer,
  keyVersion: string,
): CipherBlob {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, tenantKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== AUTH_TAG_BYTES) {
    throw new Error(`unexpected auth tag length ${tag.length}`);
  }
  const blob = Buffer.concat([iv, ct, tag]).toString('base64');
  return { cipher: blob, keyVersion };
}

// Decrypt a base64 blob produced by encryptString. Throws on auth-tag
// mismatch (tampering / wrong key). Caller is responsible for choosing
// the right tenantKey for the keyVersion stored alongside the blob.
export function decryptString(blob: string, tenantKey: Buffer): string {
  const buf = Buffer.from(blob, 'base64');
  if (buf.length < IV_BYTES + AUTH_TAG_BYTES) {
    throw new Error('cipher blob too short');
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(buf.length - AUTH_TAG_BYTES);
  const ct = buf.subarray(IV_BYTES, buf.length - AUTH_TAG_BYTES);
  const decipher = createDecipheriv(ALGO, tenantKey, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

// Deterministic exact-match lookup hash. SHA-256 of the normalized
// value — no salt, intentionally, because the column is for equality
// search ("find patient by Aadhaar"). The hash leaks the value to
// anyone with read access to the column, which is why the column is
// behind the same RLS as the ciphertext.
export function lookupHash(value: string): string {
  const normalized = value.trim().toLowerCase();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}
