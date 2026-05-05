// JWE/JWS helpers for the NHCX gateway. The gateway expects:
//   * Outbound payloads encrypted with the gateway's RSA public key
//     (RSA-OAEP-256 key wrap + A256GCM content encryption).
//   * Inbound payloads encrypted to OUR RSA public key with the same
//     algorithms.
//
// We intentionally use `jose` (modern, audited) over the legacy
// `node-jose` package — same JWE primitives, smaller surface, native
// TypeScript types.

import { compactDecrypt, CompactEncrypt, importPKCS8, importSPKI, type KeyLike } from 'jose';

const KEY_ALG = 'RSA-OAEP-256';
const CONTENT_ENC = 'A256GCM';

// Cache imported keys so we don't re-parse on every request. The cache
// key is the PEM string itself — when keys rotate, the new PEM produces
// a fresh entry. Map is bounded by the number of distinct keys passed
// in (one per role: ours-private + gateway-public), so it never grows.
const keyCache = new Map<string, KeyLike>();

async function loadPrivateKey(pem: string): Promise<KeyLike> {
  const cached = keyCache.get(pem);
  if (cached) return cached;
  const key = await importPKCS8(pem, KEY_ALG);
  keyCache.set(pem, key);
  return key;
}

async function loadPublicKey(pem: string): Promise<KeyLike> {
  const cached = keyCache.get(pem);
  if (cached) return cached;
  const key = await importSPKI(pem, KEY_ALG);
  keyCache.set(pem, key);
  return key;
}

// Encrypt a JSON-serialisable payload to the gateway. Returns a compact
// JWE (5 dot-separated base64url segments).
export async function encryptToParticipant(
  payload: unknown,
  recipientPublicKeyPem: string,
): Promise<string> {
  const recipientKey = await loadPublicKey(recipientPublicKeyPem);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  return new CompactEncrypt(plaintext)
    .setProtectedHeader({ alg: KEY_ALG, enc: CONTENT_ENC })
    .encrypt(recipientKey);
}

// Decrypt a compact JWE that was encrypted to our public key. Returns
// the parsed JSON. Throws JOSE-typed errors on malformed / wrong-key
// inputs — let those bubble; the adapter wraps them in
// IntegrationFailedError.
export async function decryptFromParticipant<T = unknown>(
  compactJwe: string,
  ourPrivateKeyPem: string,
): Promise<T> {
  const ourKey = await loadPrivateKey(ourPrivateKeyPem);
  const { plaintext } = await compactDecrypt(compactJwe, ourKey);
  const text = new TextDecoder().decode(plaintext);
  return JSON.parse(text) as T;
}

// Test-only escape hatch — clears the key cache so a unit test can
// rotate keys mid-suite without seeing stale entries.
export function _resetKeyCacheForTests(): void {
  keyCache.clear();
}
