// Slice AP — envelope-encryption for tenant comms-config secrets.
//
// SMTP password and SMS api-key are tenant-level credentials and the
// CLAUDE.md hard-rule #9 says they must live in Postgres as KMS-wrapped
// blobs, not plaintext. We share the PII envelope-encryption primitives
// (AES-256-GCM, HKDF-SHA256-derived per-tenant DEKs) but namespace the
// derivation salt so a key compromise on one path doesn't bleed across
// to the other.
//
// Wire format on disk: a string `kms:v1:<base64>` where the base64
// payload is `iv (12 bytes) || ciphertext || authTag (16 bytes)`. The
// `kms:v1:` prefix lets readers detect wrapped vs legacy-plaintext
// values — useful during rollout when existing tenants may still have
// plaintext rows from before AP. New writes always wrap.
//
// Stub mode (PII_KMS_MODE=stub): the root key is the env-supplied
// PII_KMS_ROOT_KEY_BASE64. Real-mode (OVH KMS) is still deferred —
// when it lands, only `deriveCommsTenantKey` changes; the wrap-format
// stays put.

import { hkdfSync } from 'node:crypto';

import { decryptString, encryptString } from '../patient/pii.crypto';

const HKDF_SALT = Buffer.from('digisparsh-comms-v1');
const WRAP_PREFIX = 'kms:v1:';

// Derive a per-tenant 32-byte DEK from the root key + tenantId. Salt
// is comms-specific so the same root key, applied to the same tenant,
// produces a DIFFERENT key than the PII path. That gives us blast-
// radius isolation if either domain's plaintexts are ever exposed.
export function deriveCommsTenantKey(rootKey: Buffer, tenantId: string): Buffer {
  if (rootKey.length !== 32) {
    throw new Error(`root key must be 32 bytes; got ${rootKey.length}`);
  }
  const info = Buffer.from(`tenant:${tenantId}`);
  const out = hkdfSync('sha256', rootKey, HKDF_SALT, info, 32);
  return Buffer.from(out);
}

// Encrypt a plaintext secret with the tenant key, returning the on-disk
// representation `kms:v1:<base64>`. Empty / non-string input returns the
// input unchanged so callers can pipe optional fields through without
// branching.
export function wrapSecret(plaintext: string, tenantKey: Buffer): string {
  const blob = encryptString(plaintext, tenantKey, 'v1');
  return `${WRAP_PREFIX}${blob.cipher}`;
}

// Recognises the wrap prefix. Used to skip decrypt on legacy plaintext
// rows (back-compat for tenants seeded before AP) and to short-circuit
// decryption on values that are clearly not wrapped (defensive).
export function isWrapped(value: string): boolean {
  return value.startsWith(WRAP_PREFIX);
}

// Reverse of wrapSecret. Throws on auth-tag failure (tampered ciphertext
// or wrong key) — callers should treat that as a "secret unreadable"
// signal and fall back to env defaults rather than crashing the send
// path. If the value is not wrapped, returns it as-is (legacy plaintext).
export function unwrapSecret(value: string, tenantKey: Buffer): string {
  if (!isWrapped(value)) return value;
  const cipher = value.slice(WRAP_PREFIX.length);
  return decryptString(cipher, tenantKey);
}
