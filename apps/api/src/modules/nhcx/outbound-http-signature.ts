// Outbound HTTP Signature builder for NHCX (Cavage draft, rsa-sha256).
//
// Symmetric to `inbound/http-signature.ts` but on the production side
// of the wire: every outbound call we make to NHA's gateway should
// carry a `Signature` header so the gateway can verify the request
// came from us and the body hasn't been tampered with in transit.
// NHA's sandbox does not enforce this today (see GAP_ANALYSIS.md row
// 9.7) but the production gateway is expected to, and the cost of
// always signing is one RSA op per outbound call.
//
// What we sign:
//   - `(request-target)` (method + path)
//   - `host`
//   - `date` (HTTP-date format)
//   - `digest` (SHA-256 of the JWE body, base64-encoded)
//   - `x-hcx-correlation-id`
//   - `x-hcx-operation`
//
// These are the same six headers the inbound verifier requires —
// guarantees the gateway's verifier and ours are looking at the
// same data shape end-to-end.
//
// Algorithm: rsa-sha256 over the canonical signing string built by
// the shared helper from the inbound module. We reuse those helpers
// to keep the two sides bit-for-bit symmetric.

import { createSign } from 'node:crypto';

import { buildSigningString, computeDigest } from './inbound/http-signature';

export interface OutboundSignInput {
  // HTTP method, uppercased ('POST').
  method: string;
  // Request path including query string. The verifier expects this
  // lowercased; we pass it through as-is and let callers normalise.
  path: string;
  // Host header value (no port unless the URL had one). Used both in
  // the signing string and as the canonical Host header on the wire.
  host: string;
  // The raw body bytes that will be POSTed. We compute the Digest
  // header from this and bind it into the signature.
  body: Buffer;
  // Outbound HTTP headers that already exist on the request — we read
  // x-hcx-correlation-id and x-hcx-operation from here so the signing
  // string covers exactly what the gateway sees on the wire. Lowercase
  // names; Cavage is case-insensitive but downstream HTTP libraries
  // are not.
  headers: Record<string, string>;
  // PEM-encoded RSA private key matching the keyId below.
  privateKeyPem: string;
  // Identifier the verifier uses to look up our public key. Recommended
  // format: `<participantCode>:<version>` (e.g. 'example@hcx:v1') so the
  // gateway can match against the public-key submission they hold.
  keyId: string;
  // Current wall-clock; tests pass a fixed Date to keep signatures
  // reproducible.
  now: Date;
}

export interface SignedHeaders {
  // The seven headers (six base + `signature`) the caller should add
  // to the outgoing request, in addition to whatever else was already
  // present. Case-insensitive names but we return lowercased keys so
  // callers can spread into a plain object.
  date: string;
  digest: string;
  signature: string;
  host: string;
}

// Names the signature covers, in order — also the value of the
// `headers` parameter inside the Signature header.
const SIGNED_HEADER_NAMES = [
  '(request-target)',
  'host',
  'date',
  'digest',
  'x-hcx-correlation-id',
  'x-hcx-operation',
] as const;

// Format a Date as RFC 1123 / HTTP-date ("Sun, 06 Nov 1994 08:49:37 GMT").
// Node's Date.toUTCString() is exactly that format and is what every
// Cavage implementation expects.
function httpDate(d: Date): string {
  return d.toUTCString();
}

export function signOutboundRequest(input: OutboundSignInput): SignedHeaders {
  const digest = computeDigest(input.body);
  const date = httpDate(input.now);
  // Build the header map the signing-string builder consumes. Lowercase
  // keys match what the inbound helper expects.
  const headersForSigning: Record<string, string> = {
    host: input.host,
    date,
    digest,
    'x-hcx-correlation-id': input.headers['x-hcx-correlation-id'] ?? '',
    'x-hcx-operation': input.headers['x-hcx-operation'] ?? '',
  };
  const signingString = buildSigningString(
    [...SIGNED_HEADER_NAMES],
    input.method,
    input.path,
    headersForSigning,
  );
  if (signingString === null) {
    // Unreachable in practice — we only signal `null` when one of the
    // signed headers is missing, and the map above guarantees all
    // six are present. The check exists so a future refactor that
    // drops a header surfaces clearly here rather than as a verify
    // failure on the gateway side.
    throw new Error('signOutboundRequest: failed to build signing string');
  }
  const signer = createSign('RSA-SHA256');
  signer.update(signingString);
  signer.end();
  const signature = signer.sign(input.privateKeyPem).toString('base64');
  const signatureHeader =
    `keyId="${input.keyId}",` +
    `algorithm="rsa-sha256",` +
    `headers="${SIGNED_HEADER_NAMES.join(' ')}",` +
    `signature="${signature}"`;
  return {
    date,
    digest,
    host: input.host,
    signature: signatureHeader,
  };
}
