// Slice AO — unit coverage for the HTTP Signature verifier.
//
// Generates an RSA keypair in beforeAll, signs a synthetic request, then
// pokes the verifier with happy-path + each adversarial mutation. The
// verifier is pure (no I/O), so we can keep this fast.

import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';

import {
  buildSigningString,
  computeDigest,
  parseSignatureHeader,
  verifyHttpSignature,
} from './http-signature';

interface SignedRequest {
  headers: Record<string, string>;
  rawBody: Buffer;
  publicKeyPem: string;
}

function signRequest(opts: {
  body: Buffer;
  date: string;
  correlationId: string;
  operation: string;
  privateKey: KeyObject;
  publicKeyPem: string;
  keyId?: string;
}): SignedRequest {
  const digest = computeDigest(opts.body);
  const headers: Record<string, string> = {
    host: 'claims.example.com',
    date: opts.date,
    digest,
    'x-hcx-correlation-id': opts.correlationId,
    'x-hcx-operation': opts.operation,
  };
  const signedHeaderNames = [
    '(request-target)',
    'host',
    'date',
    'digest',
    'x-hcx-correlation-id',
    'x-hcx-operation',
  ];
  const signingString = buildSigningString(
    signedHeaderNames,
    'POST',
    '/nhcx/inbound',
    headers,
  );
  if (signingString === null) throw new Error('test setup: missing header');
  const signer = createSign('RSA-SHA256');
  signer.update(signingString);
  signer.end();
  const signature = signer.sign(opts.privateKey).toString('base64');
  const sigHeader = [
    `keyId="${opts.keyId ?? 'gateway-v1'}"`,
    `algorithm="rsa-sha256"`,
    `headers="${signedHeaderNames.join(' ')}"`,
    `signature="${signature}"`,
  ].join(',');
  return {
    headers: { ...headers, signature: sigHeader },
    rawBody: opts.body,
    publicKeyPem: opts.publicKeyPem,
  };
}

describe('http-signature verifier', () => {
  let privateKey: KeyObject;
  let publicKeyPem: string;
  // Pin the wall clock to a known instant so skew assertions are
  // deterministic. The signed `date` header below sits at `now`, well
  // inside the 300s window.
  const NOW = new Date('2026-05-07T12:00:00Z');
  const DATE_HEADER = 'Thu, 07 May 2026 12:00:00 GMT';

  beforeAll(() => {
    const { privateKey: priv, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = priv;
    publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  });

  function freshSigned(overrides: { body?: Buffer; correlationId?: string } = {}): SignedRequest {
    return signRequest({
      body: overrides.body ?? Buffer.from(JSON.stringify({ payload: 'jwe-blob' }), 'utf8'),
      date: DATE_HEADER,
      correlationId: overrides.correlationId ?? 'corr-1',
      operation: 'preauth/on_submit',
      privateKey,
      publicKeyPem,
    });
  }

  it('parseSignatureHeader extracts keyId / algorithm / headers / signature', () => {
    const parsed = parseSignatureHeader(
      'keyId="g-v1",algorithm="rsa-sha256",headers="(request-target) host date",signature="QUJD"',
    );
    expect(parsed).toEqual({
      keyId: 'g-v1',
      algorithm: 'rsa-sha256',
      headers: ['(request-target)', 'host', 'date'],
      signature: 'QUJD',
    });
  });

  it('parseSignatureHeader returns null on a malformed header', () => {
    expect(parseSignatureHeader('not-a-signature')).toBeNull();
    // Missing required field.
    expect(
      parseSignatureHeader('keyId="g",algorithm="rsa-sha256",headers="host"'),
    ).toBeNull();
  });

  it('verifies a well-formed gateway signature', () => {
    const req = freshSigned();
    const result = verifyHttpSignature({
      method: 'POST',
      path: '/nhcx/inbound',
      headers: req.headers,
      rawBody: req.rawBody,
      publicKeyPem: req.publicKeyPem,
      now: NOW,
      maxSkewSeconds: 300,
    });
    expect(result).toEqual({ ok: true });
  });

  it('rejects when the body is tampered after signing', () => {
    const req = freshSigned();
    const result = verifyHttpSignature({
      method: 'POST',
      path: '/nhcx/inbound',
      headers: req.headers,
      rawBody: Buffer.from('{"payload":"swapped"}'),
      publicKeyPem: req.publicKeyPem,
      now: NOW,
      maxSkewSeconds: 300,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Digest header does not match/);
  });

  it('rejects when the signature itself is corrupted', () => {
    const req = freshSigned();
    const corrupted = req.headers['signature']!.replace(
      /signature="[^"]+"/,
      'signature="QUJDREVG"',
    );
    const result = verifyHttpSignature({
      method: 'POST',
      path: '/nhcx/inbound',
      headers: { ...req.headers, signature: corrupted },
      rawBody: req.rawBody,
      publicKeyPem: req.publicKeyPem,
      now: NOW,
      maxSkewSeconds: 300,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Signature does not verify/);
  });

  it('rejects when a required header is missing from the signed set', () => {
    const req = freshSigned();
    // Strip `digest` from the signed headers list — should now fail
    // even though the signature itself would still verify.
    const downgraded = req.headers['signature']!.replace(
      'headers="(request-target) host date digest x-hcx-correlation-id x-hcx-operation"',
      'headers="(request-target) host date x-hcx-correlation-id x-hcx-operation"',
    );
    const result = verifyHttpSignature({
      method: 'POST',
      path: '/nhcx/inbound',
      headers: { ...req.headers, signature: downgraded },
      rawBody: req.rawBody,
      publicKeyPem: req.publicKeyPem,
      now: NOW,
      maxSkewSeconds: 300,
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.reason).toMatch(/does not cover required header: digest/);
  });

  it('rejects when the date header is too far in the past', () => {
    const stale = signRequest({
      body: Buffer.from('{}'),
      date: 'Thu, 07 May 2026 11:00:00 GMT', // 1 hour earlier than NOW
      correlationId: 'corr-2',
      operation: 'preauth/on_submit',
      privateKey,
      publicKeyPem,
    });
    const result = verifyHttpSignature({
      method: 'POST',
      path: '/nhcx/inbound',
      headers: stale.headers,
      rawBody: stale.rawBody,
      publicKeyPem: stale.publicKeyPem,
      now: NOW,
      maxSkewSeconds: 300,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/skew \d+s exceeds max 300s/);
  });

  it('rejects on missing Signature header', () => {
    const req = freshSigned();
    const headers = { ...req.headers };
    delete headers['signature'];
    const result = verifyHttpSignature({
      method: 'POST',
      path: '/nhcx/inbound',
      headers,
      rawBody: req.rawBody,
      publicKeyPem: req.publicKeyPem,
      now: NOW,
      maxSkewSeconds: 300,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('Missing Signature header');
  });

  it('rejects unsupported algorithm', () => {
    const req = freshSigned();
    const swapped = req.headers['signature']!.replace(
      'algorithm="rsa-sha256"',
      'algorithm="hmac-sha256"',
    );
    const result = verifyHttpSignature({
      method: 'POST',
      path: '/nhcx/inbound',
      headers: { ...req.headers, signature: swapped },
      rawBody: req.rawBody,
      publicKeyPem: req.publicKeyPem,
      now: NOW,
      maxSkewSeconds: 300,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Unsupported algorithm/);
  });
});
