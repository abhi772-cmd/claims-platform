// JWE/JWS helpers for the NHCX gateway. The gateway expects:
//   * Outbound payloads encrypted with the gateway's RSA public key
//     (RSA-OAEP-256 key wrap + A256GCM content encryption).
//   * Inbound payloads encrypted to OUR RSA public key with the same
//     algorithms.
//
// We intentionally use `jose` (modern, audited) over the legacy
// `node-jose` package — same JWE primitives, smaller surface, native
// TypeScript types.

import {
  compactDecrypt,
  CompactEncrypt,
  decodeProtectedHeader,
  importPKCS8,
  importSPKI,
  type KeyLike,
} from 'jose';

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
// JWE (5 dot-separated base64url segments). When `kid` is supplied,
// it's stamped into the JWE protected header — gateway uses this to
// select the right private key on its side. Outbound calls pass our
// active private-key version so the gateway can verify which key we
// signed with.
//
// `extraHeader` lets the adapter inject the NHCX protocol fields
// (`x-hcx-sender_code`, `x-hcx-correlation_id`, etc.) into the JWE
// protected header — these MUST be authenticated by the AEAD tag so
// a gateway can detect tampering before decrypting the payload.
export async function encryptToParticipant(
  payload: unknown,
  recipientPublicKeyPem: string,
  kid?: string,
  extraHeader?: Readonly<Record<string, string | number | boolean>>,
): Promise<string> {
  const recipientKey = await loadPublicKey(recipientPublicKeyPem);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  return new CompactEncrypt(plaintext)
    .setProtectedHeader({
      alg: KEY_ALG,
      enc: CONTENT_ENC,
      ...(kid !== undefined ? { kid } : {}),
      ...(extraHeader ?? {}),
    })
    .encrypt(recipientKey);
}

// Decode the full JWE protected header so callers can verify the NHCX
// x-hcx-* fields without decrypting the payload. Returns an empty
// object when the header is malformed (caller treats as missing).
export function readJweProtectedHeader(compactJwe: string): Readonly<Record<string, unknown>> {
  try {
    return decodeProtectedHeader(compactJwe) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// Read the `kid` header off a compact JWE without attempting to
// decrypt. Used by the rotation resolver to pick the right private
// key for inbound traffic. Returns null if the header is malformed or
// the kid is absent.
export function readJweKid(compactJwe: string): string | null {
  try {
    const header = decodeProtectedHeader(compactJwe) as { kid?: unknown };
    return typeof header.kid === 'string' ? header.kid : null;
  } catch {
    return null;
  }
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
