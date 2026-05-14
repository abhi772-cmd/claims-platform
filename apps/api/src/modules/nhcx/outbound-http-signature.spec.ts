// Round-trip test for the outbound HTTP-Signature builder.
//
// The strongest correctness signal is that our outbound signer
// produces a request the *inbound* verifier accepts. Both sides
// implement Cavage rsa-sha256; if they ever drift (different
// signed-header list, different canonical form, etc.) this test
// fails. Run-of-the-mill golden-string tests would not catch a
// drift like that.

import { generateKeyPairSync } from 'node:crypto';

import { verifyHttpSignature } from './inbound/http-signature';
import { signOutboundRequest } from './outbound-http-signature';

describe('outbound HTTP Signature (signOutboundRequest)', () => {
  // RSA-2048 keypair shared across the suite; cheaper than generating
  // per-test and the keys never leave the process.
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const NOW = new Date('2026-05-11T12:00:00.000Z');
  const body = Buffer.from('compactJweBlobGoesHere.aaaa.bbbb.cccc.dddd', 'utf8');
  const baseInput = {
    method: 'POST',
    path: '/api/preauthhcxservice/preauth/submit',
    host: 'nhcx.abdm.gov.in',
    body,
    headers: {
      'x-hcx-correlation-id': 'corr-1',
      'x-hcx-operation': 'preauth/submit',
    },
    privateKeyPem: privateKey,
    keyId: 'example@hcx:v1',
    now: NOW,
  };

  it('produces a signature the inbound verifier accepts', () => {
    const signed = signOutboundRequest(baseInput);
    // Mirror the headers a real HTTP server would see on receipt of
    // the signed request. The verifier reads from this map.
    const verify = verifyHttpSignature({
      method: 'POST',
      path: baseInput.path,
      headers: {
        host: signed.host,
        date: signed.date,
        digest: signed.digest,
        signature: signed.signature,
        'x-hcx-correlation-id': baseInput.headers['x-hcx-correlation-id'],
        'x-hcx-operation': baseInput.headers['x-hcx-operation'],
      },
      rawBody: baseInput.body,
      publicKeyPem: publicKey,
      now: NOW,
      maxSkewSeconds: 300,
    });
    expect(verify).toEqual({ ok: true });
  });

  it('binds the body via Digest — a swapped body fails verify', () => {
    const signed = signOutboundRequest(baseInput);
    const verify = verifyHttpSignature({
      method: 'POST',
      path: baseInput.path,
      headers: {
        host: signed.host,
        date: signed.date,
        digest: signed.digest,
        signature: signed.signature,
        'x-hcx-correlation-id': baseInput.headers['x-hcx-correlation-id'],
        'x-hcx-operation': baseInput.headers['x-hcx-operation'],
      },
      rawBody: Buffer.from('tampered-body', 'utf8'),
      publicKeyPem: publicKey,
      now: NOW,
      maxSkewSeconds: 300,
    });
    expect(verify).toEqual({ ok: false, reason: 'Digest header does not match body SHA-256' });
  });

  it('rejects when correlation-id is dropped from the request map', () => {
    const signed = signOutboundRequest(baseInput);
    const verify = verifyHttpSignature({
      method: 'POST',
      path: baseInput.path,
      headers: {
        host: signed.host,
        date: signed.date,
        digest: signed.digest,
        signature: signed.signature,
        // correlation id intentionally absent — the verifier checks
        // the signed-headers list bound by the signature includes it,
        // but if the actual header is gone the signing string the
        // verifier rebuilds won't match.
        'x-hcx-operation': baseInput.headers['x-hcx-operation'],
      },
      rawBody: baseInput.body,
      publicKeyPem: publicKey,
      now: NOW,
      maxSkewSeconds: 300,
    });
    expect(verify.ok).toBe(false);
  });

  it('skew check fires when wall clock drifts past the window', () => {
    const signed = signOutboundRequest(baseInput);
    const verify = verifyHttpSignature({
      method: 'POST',
      path: baseInput.path,
      headers: {
        host: signed.host,
        date: signed.date,
        digest: signed.digest,
        signature: signed.signature,
        'x-hcx-correlation-id': baseInput.headers['x-hcx-correlation-id'],
        'x-hcx-operation': baseInput.headers['x-hcx-operation'],
      },
      rawBody: baseInput.body,
      publicKeyPem: publicKey,
      now: new Date(NOW.getTime() + 10 * 60 * 1000),
      maxSkewSeconds: 300,
    });
    expect(verify.ok).toBe(false);
    expect((verify as { reason: string }).reason).toMatch(/skew/);
  });

  it('Signature header is well-formed Cavage', () => {
    const { signature } = signOutboundRequest(baseInput);
    expect(signature).toMatch(/keyId="example@hcx:v1"/);
    expect(signature).toMatch(/algorithm="rsa-sha256"/);
    // Header list order must match what the inbound verifier requires.
    expect(signature).toMatch(
      /headers="\(request-target\) host date digest x-hcx-correlation-id x-hcx-operation"/,
    );
    expect(signature).toMatch(/signature="[A-Za-z0-9+/=]+"/);
  });

  it('digest is SHA-256 of the body in base64', () => {
    const { digest } = signOutboundRequest(baseInput);
    expect(digest).toMatch(/^SHA-256=[A-Za-z0-9+/=]+$/);
  });
});
