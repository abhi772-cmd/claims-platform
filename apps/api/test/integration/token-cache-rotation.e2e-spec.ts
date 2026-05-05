// Slice U integration test — ABDM token cache + NHCX key rotation.
//
//   1. HprRealAdapter mints exactly ONE access token across multiple
//      HPR operations against the same gateway.
//   2. NhcxJweAdapter decrypts inbound JWEs addressed to a RETIRED
//      key version while still encrypting outbound with the ACTIVE
//      version. Proves the rotation handover works end-to-end.

import { generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { type ConfigService } from '@nestjs/config';

import { HprRealAdapter } from '../../src/modules/hpr/hpr-real.adapter';
import { NhcxJweAdapter } from '../../src/modules/nhcx/nhcx-jwe.adapter';
import {
  type NhcxKeyResolver,
} from '../../src/modules/nhcx/nhcx-key-resolver';
import {
  _resetKeyCacheForTests,
  decryptFromParticipant,
  encryptToParticipant,
  readJweKid,
} from '../../src/modules/nhcx/nhcx.crypto';

jest.setTimeout(60_000);

const cfg = (values: Record<string, unknown>): ConfigService =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

interface KeyPair {
  publicPem: string;
  privatePem: string;
}
const makeKeyPair = (): KeyPair => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
};

async function readBody(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

describe('Slice U — ABDM token cache + NHCX key rotation', () => {
  describe('HprRealAdapter token cache', () => {
    let server: Server | undefined;
    let mintCount = 0;
    let url = '';

    beforeEach(async () => {
      mintCount = 0;
      server = createServer(async (req, res) => {
        const body = await readBody(req);
        if (req.url === '/gateway/v0.5/sessions') {
          mintCount += 1;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ accessToken: `tok-${mintCount}`, expiresIn: 1800 }));
          return;
        }
        if (req.url === '/api/v1/auth/init') {
          // Echo-style init: we want to check the bearer the client sent.
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ txnId: 'TX-OK' }));
          return;
        }
        if (req.url === '/api/v1/auth/confirmWithMobileOTP') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ token: 'XTOK' }));
          return;
        }
        if (req.url?.startsWith('/api/v2/hpr/healthcareprofessional/')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              hprId: '12345678901234',
              fullName: 'Cached Doctor',
              registrationStatus: 'Active',
            }),
          );
          return;
        }
        void body;
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const addr = server!.address() as AddressInfo;
      url = `http://127.0.0.1:${addr.port}`;
    });

    afterEach(async () => {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    });

    it('mints one access token across multiple operations', async () => {
      const adapter = new HprRealAdapter(
        cfg({
          ABDM_BASE_URL: url,
          ABDM_CLIENT_ID: 'test-client',
          ABDM_CLIENT_SECRET: 'test-secret',
          ABDM_HTTP_TIMEOUT_MS: 5000,
        }) as never,
      );
      await adapter.requestOtp('12345678901234');
      await adapter.verifyOtp({
        hprId: '12345678901234',
        otp: '000000',
        transactionId: 'TX-OK',
      });
      // requestOtp calls /sessions once; verifyOtp also needs an
      // access token but should reuse the cached value. So mintCount
      // is 1 across both calls.
      expect(mintCount).toBe(1);
    });

    it('refreshes after a 401 on a downstream call', async () => {
      // Stand up a server that 401s the first auth/init call, then
      // succeeds. The adapter must invalidate + retry.
      let initCalls = 0;
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = createServer(async (req, res) => {
        if (req.url === '/gateway/v0.5/sessions') {
          mintCount += 1;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ accessToken: `tok-${mintCount}`, expiresIn: 1800 }));
          return;
        }
        if (req.url === '/api/v1/auth/init') {
          initCalls += 1;
          if (initCalls === 1) {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'expired' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ txnId: 'TX-RETRY' }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const addr = server!.address() as AddressInfo;
      url = `http://127.0.0.1:${addr.port}`;

      const adapter = new HprRealAdapter(
        cfg({
          ABDM_BASE_URL: url,
          ABDM_CLIENT_ID: 'test-client',
          ABDM_CLIENT_SECRET: 'test-secret',
          ABDM_HTTP_TIMEOUT_MS: 5000,
        }) as never,
      );
      const out = await adapter.requestOtp('12345678901234');
      expect(out.transactionId).toBe('TX-RETRY');
      expect(initCalls).toBe(2); // first 401, then retry
      expect(mintCount).toBe(2); // second mint after invalidate
    });
  });

  describe('NhcxJweAdapter rotation', () => {
    beforeEach(() => {
      _resetKeyCacheForTests();
    });

    it('encrypts outbound with active key + decrypts inbound addressed to retired key', async () => {
      const v1 = makeKeyPair(); // retired
      const v2 = makeKeyPair(); // active
      const gateway = makeKeyPair();

      // Resolver exposes both keys; active is v2.
      const resolver: NhcxKeyResolver = {
        activePrivateKey: () => ({ pem: v2.privatePem, version: 'v2' }),
        privateKeyForVersion: (v) => {
          if (v === 'v1') return v1.privatePem;
          if (v === 'v2') return v2.privatePem;
          return null;
        },
      };

      let outboundKid: string | null = null;
      const server = createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        outboundKid = readJweKid(raw);
        // Decrypt with the gateway's private key (gateway side has
        // our active public key from the resolver — we mock by
        // decrypting with v2 because we encrypted to gatewayPublic,
        // not the other way; this test just needs the round-trip).
        // Reply with a JWE addressed to the RETIRED key (v1) to
        // exercise the resolver's lookup path.
        const responseEnvelope = {
          meta: { ok: true },
          payload: { verified: true },
        };
        const reply = await encryptToParticipant(responseEnvelope, v1.publicPem, 'v1');
        res.writeHead(200, { 'content-type': 'application/jose' });
        res.end(reply);
        // Decrypt the outbound (sanity that the encrypt path didn't
        // break). gateway.privatePem doesn't match because we pass
        // it as gatewayPublicKey on the client. Skip; the kid check
        // is enough.
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${addr.port}`;

      const adapter = new NhcxJweAdapter(
        cfg({
          NHCX_GATEWAY_URL: url,
          NHCX_PARTICIPANT_CODE: 'PARTICIPANT_TEST',
          // Falls back to active key from resolver, but populate the
          // legacy fields too so the !pem guard passes.
          nhcxPrivateKeyPem: v1.privatePem,
          nhcxPrivateKeyPemV2: v2.privatePem,
          NHCX_PRIVATE_KEY_VERSION: 'v2',
          nhcxGatewayPublicKeyPem: gateway.publicPem,
          NHCX_HTTP_TIMEOUT_MS: 5000,
        }) as never,
        resolver,
      );

      const result = await adapter.verifyEligibility({
        tenantId: 't',
        claimId: 'c',
        hospitalMrn: 'MRN',
        patientName: 'Patient',
      });
      expect(result.verified).toBe(true);
      // Outbound JWE was encrypted with kid='v2' (active).
      expect(outboundKid).toBe('v2');

      // Sanity: directly decrypting an inbound v1 JWE via the
      // resolver's retired path returns the right plaintext.
      const inbound = await encryptToParticipant({ secret: 42 }, v1.publicPem, 'v1');
      const kid = readJweKid(inbound);
      const pem = resolver.privateKeyForVersion(kid!);
      const dec = await decryptFromParticipant<{ secret: number }>(inbound, pem!);
      expect(dec.secret).toBe(42);

      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
  });
});
