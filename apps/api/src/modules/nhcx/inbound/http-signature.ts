// Slice AO — HTTP Signature verifier for the public NHCX inbound webhook.
//
// HCX 0.7.1 follows the Cavage HTTP-Signatures draft: the gateway picks
// a set of headers to sign, builds a deterministic signing string from
// them, signs with its private key, and ships the result in the
// `Signature` header along with `keyId`, `algorithm`, and the list of
// signed headers. Body integrity is bound in via a `Digest` header
// (SHA-256 of the raw body, base64-encoded).
//
// We support a deliberately narrow profile, matching what real HCX
// gateways send today:
//   - algorithm: rsa-sha256 (== rsa-pkcs1-v1_5 SHA-256)
//   - signed headers: must include `(request-target)`, `host`, `date`,
//     `digest`, `x-hcx-correlation-id`, and `x-hcx-operation`. Missing
//     any of these = reject.
//   - clock skew: configurable max (default 5 min) against the `date`
//     header so we don't accept replays from yesterday's traffic.
//
// The verifier is pure — given headers, method, path, raw body, public
// key, and current time it returns success / failure with a short
// reason. The Nest guard layer above it is the only thing that touches
// the request object.

import { createHash, createVerify } from 'node:crypto';

export interface VerifyInput {
  // HTTP method, uppercased ('POST').
  method: string;
  // Request path including query, lowercased per Cavage's spec
  // ('/nhcx/inbound').
  path: string;
  // Lowercased header name → first value. Multi-valued headers must
  // be joined by ', ' before being placed here (matches what
  // express's `req.get` returns and what Cavage expects).
  headers: Record<string, string | undefined>;
  // The bytes the gateway POSTed. Required to verify the Digest header.
  rawBody: Buffer;
  // PEM-encoded RSA public key (gateway's). The same key we already
  // use for outbound JWE encryption — HCX participants register a
  // single keypair for both purposes.
  publicKeyPem: string;
  // Wall clock at the time of verification (Date instance — tests pass
  // a fixed time to keep skew assertions deterministic).
  now: Date;
  // Maximum allowed skew between the signature's `date` header and
  // `now`, in seconds. Anything outside the window is rejected.
  maxSkewSeconds: number;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: string };

const REQUIRED_SIGNED_HEADERS = [
  '(request-target)',
  'host',
  'date',
  'digest',
  'x-hcx-correlation-id',
  'x-hcx-operation',
] as const;

interface SignatureParams {
  keyId: string;
  algorithm: string;
  headers: string[];
  signature: string;
}

// Tokenises the `Signature` header. Cavage uses key="value" pairs
// separated by commas; values are quoted-string. We do the minimum
// needed: split on top-level commas, split each pair on the first '=',
// strip the surrounding quotes. Anything malformed → null and the
// caller rejects.
export function parseSignatureHeader(value: string): SignatureParams | null {
  const parts: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of value) {
    if (ch === '"') depth = depth === 0 ? 1 : 0;
    if (ch === ',' && depth === 0) {
      parts.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.length > 0) parts.push(buf);

  const map: Record<string, string> = {};
  for (const raw of parts) {
    const eq = raw.indexOf('=');
    if (eq <= 0) return null;
    const k = raw.slice(0, eq).trim();
    let v = raw.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    map[k] = v;
  }
  const keyId = map['keyId'];
  const algorithm = map['algorithm'];
  const headersRaw = map['headers'];
  const signature = map['signature'];
  if (!keyId || !algorithm || !headersRaw || !signature) return null;
  return {
    keyId,
    algorithm,
    headers: headersRaw.split(/\s+/).filter((s) => s.length > 0),
    signature,
  };
}

// Rebuilds the byte string the gateway signed. Each header listed in
// the `headers` parameter contributes one `name: value` line, joined
// with '\n'. The pseudo-header `(request-target)` is special: it
// expands to `<method> <path>`.
export function buildSigningString(
  signedHeaderNames: string[],
  method: string,
  path: string,
  headers: Record<string, string | undefined>,
): string | null {
  const lines: string[] = [];
  for (const name of signedHeaderNames) {
    if (name === '(request-target)') {
      lines.push(`(request-target): ${method.toLowerCase()} ${path}`);
      continue;
    }
    const value = headers[name.toLowerCase()];
    if (value === undefined) return null;
    lines.push(`${name.toLowerCase()}: ${value}`);
  }
  return lines.join('\n');
}

// Computes the canonical Digest header value for `body`. HCX uses
// SHA-256; the result is `SHA-256=<base64(hash)>`.
export function computeDigest(body: Buffer): string {
  const hash = createHash('sha256').update(body).digest('base64');
  return `SHA-256=${hash}`;
}

export function verifyHttpSignature(input: VerifyInput): VerifyResult {
  const sigHeader = input.headers['signature'];
  if (!sigHeader) return { ok: false, reason: 'Missing Signature header' };
  const params = parseSignatureHeader(sigHeader);
  if (!params) return { ok: false, reason: 'Malformed Signature header' };

  // Algorithm: only rsa-sha256 is in scope. Reject everything else
  // explicitly so a downgrade attack can't slip past.
  if (params.algorithm.toLowerCase() !== 'rsa-sha256') {
    return { ok: false, reason: `Unsupported algorithm: ${params.algorithm}` };
  }

  // The set of headers signed must include every header we care about
  // — otherwise an attacker could strip e.g. `digest` and the
  // signature would still verify against whatever's left.
  const signedSet = new Set(params.headers.map((h) => h.toLowerCase()));
  for (const required of REQUIRED_SIGNED_HEADERS) {
    if (!signedSet.has(required)) {
      return { ok: false, reason: `Signature does not cover required header: ${required}` };
    }
  }

  // Digest must match SHA-256 of the raw body. This is what binds the
  // signature to the actual payload — without it the signature only
  // covers the headers and an attacker could swap the body freely.
  const digestHeader = input.headers['digest'];
  if (!digestHeader) return { ok: false, reason: 'Missing Digest header' };
  const expectedDigest = computeDigest(input.rawBody);
  if (digestHeader !== expectedDigest) {
    return { ok: false, reason: 'Digest header does not match body SHA-256' };
  }

  // Clock skew check via the `date` header. We already required it to
  // be in the signed-headers list, so we know the value is bound to
  // the signature.
  const dateHeader = input.headers['date'];
  if (!dateHeader) return { ok: false, reason: 'Missing Date header' };
  const dateMs = Date.parse(dateHeader);
  if (Number.isNaN(dateMs)) {
    return { ok: false, reason: 'Date header is not a parseable HTTP date' };
  }
  const skewSeconds = Math.abs(input.now.getTime() - dateMs) / 1000;
  if (skewSeconds > input.maxSkewSeconds) {
    return {
      ok: false,
      reason: `Date header skew ${Math.floor(skewSeconds)}s exceeds max ${input.maxSkewSeconds}s`,
    };
  }

  const signingString = buildSigningString(
    params.headers,
    input.method,
    input.path,
    input.headers,
  );
  if (signingString === null) {
    return { ok: false, reason: 'A signed header is missing from the request' };
  }

  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(params.signature, 'base64');
  } catch {
    return { ok: false, reason: 'Signature is not valid base64' };
  }

  const verifier = createVerify('RSA-SHA256');
  verifier.update(signingString);
  verifier.end();
  let ok = false;
  try {
    ok = verifier.verify(input.publicKeyPem, signatureBytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Signature verify threw: ${message}` };
  }
  if (!ok) return { ok: false, reason: 'Signature does not verify against gateway public key' };
  return { ok: true };
}
