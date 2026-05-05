// Slice P integration test — NhcxJweAdapter end-to-end against an
// in-process mock NHCX gateway. We spin up an HTTP server that:
//   1. accepts the JWE on POST,
//   2. decrypts it with our gateway-side private key,
//   3. responds with a JWE encrypted to the participant's public key.
//
// This exercises both crypto directions and the HTTP plumbing without
// needing the real NHCX endpoint.

import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { type ConfigService } from '@nestjs/config';

import { NhcxJweAdapter } from '../../src/modules/nhcx/nhcx-jwe.adapter';
import {
  decryptFromParticipant,
  encryptToParticipant,
  _resetKeyCacheForTests,
} from '../../src/modules/nhcx/nhcx.crypto';

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

interface MockGateway {
  url: string;
  shutdown: () => Promise<void>;
  lastRequest: () => unknown;
}

async function startMockGateway(
  gateway: KeyPair,
  participant: KeyPair,
  responder: (req: { operation: string; body: unknown }) => unknown,
): Promise<MockGateway> {
  let lastReq: unknown;
  const server: Server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const decrypted = await decryptFromParticipant<{
        meta: { operation: string };
        payload: unknown;
      }>(body, gateway.privatePem);
      lastReq = decrypted;
      const payload = responder({ operation: decrypted.meta.operation, body: decrypted });
      const envelope = { meta: { acknowledged: true }, payload };
      const encrypted = await encryptToParticipant(envelope, participant.publicPem);
      res.writeHead(200, { 'content-type': 'application/jose' });
      res.end(encrypted);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    shutdown: () => new Promise((resolve) => server.close(() => resolve())),
    lastRequest: () => lastReq,
  };
}

// Cast through `as never` so the test doesn't need to provide every
// AppConfig field. NhcxJweAdapter only reads a handful of keys.
const cfg = (values: Record<string, unknown>): ConfigService =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

interface AdapterCfg {
  url: string;
  participantPriv: string;
  gatewayPub: string;
}

const buildAdapter = (c: AdapterCfg): NhcxJweAdapter =>
  new NhcxJweAdapter(
    cfg({
      NHCX_GATEWAY_URL: c.url,
      NHCX_PARTICIPANT_CODE: 'PARTICIPANT_TEST',
      nhcxPrivateKeyPem: c.participantPriv,
      nhcxGatewayPublicKeyPem: c.gatewayPub,
      NHCX_HTTP_TIMEOUT_MS: 5000,
    }) as never,
  );

describe('Slice P — NhcxJweAdapter against mock gateway', () => {
  let gateway: KeyPair;
  let participant: KeyPair;
  let mock: MockGateway | undefined;

  beforeEach(() => {
    _resetKeyCacheForTests();
    gateway = makeKeyPair();
    participant = makeKeyPair();
  });

  afterEach(async () => {
    if (mock) {
      await mock.shutdown();
      mock = undefined;
    }
  });

  it('verifyEligibility: encrypts outbound, decrypts inbound, returns shape', async () => {
    mock = await startMockGateway(gateway, participant, ({ operation }) => {
      expect(operation).toBe('coverage-eligibility/check');
      return {
        verified: true,
        planName: 'Real Plan Gold',
        sumInsured: 750_000,
      };
    });
    const adapter = buildAdapter({
      url: mock.url,
      participantPriv: participant.privatePem,
      gatewayPub: gateway.publicPem,
    });

    const result = await adapter.verifyEligibility({
      tenantId: 'tenant-1',
      claimId: 'claim-1',
      hospitalMrn: 'MRN-PROD',
      patientName: 'Test Patient',
    });

    expect(result.verified).toBe(true);
    expect(result.planName).toBe('Real Plan Gold');
    expect(result.sumInsured).toBe(750_000);
    expect(result.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('submitPreauth: returns payerRefNum from the gateway response', async () => {
    mock = await startMockGateway(gateway, participant, ({ operation, body }) => {
      expect(operation).toBe('preauth/submit');
      const b = body as { payload: { payload: { requestedAmount: number } } };
      expect(b.payload.payload.requestedAmount).toBe(250_000);
      return {
        acknowledged: true,
        payerRefNum: 'GW-PA-ABC123',
      };
    });
    const adapter = buildAdapter({
      url: mock.url,
      participantPriv: participant.privatePem,
      gatewayPub: gateway.publicPem,
    });

    const result = await adapter.submitPreauth({
      tenantId: 'tenant-1',
      claimId: 'claim-1',
      requestedAmount: 250_000,
    });
    expect(result.acknowledged).toBe(true);
    expect(result.payerRefNum).toBe('GW-PA-ABC123');
  });

  it('outbound payload is opaque on the wire (encrypted, not plaintext)', async () => {
    let rawBytes = '';
    const raw = createServer(async (req, res) => {
      for await (const chunk of req) rawBytes += chunk;
      const envelope = {
        meta: { acknowledged: true },
        payload: { verified: true },
      };
      const enc = await encryptToParticipant(envelope, participant.publicPem);
      res.writeHead(200, { 'content-type': 'application/jose' });
      res.end(enc);
    });
    await new Promise<void>((resolve) => raw.listen(0, '127.0.0.1', resolve));
    const addr = raw.address() as AddressInfo;
    try {
      const adapter = buildAdapter({
        url: `http://127.0.0.1:${addr.port}`,
        participantPriv: participant.privatePem,
        gatewayPub: gateway.publicPem,
      });

      await adapter.verifyEligibility({
        tenantId: 'tenant-1',
        claimId: 'claim-1',
        hospitalMrn: 'MRN-OPAQUE',
        patientName: 'Patient',
      });

      // The MRN must NOT appear in the wire bytes.
      expect(rawBytes).not.toContain('MRN-OPAQUE');
      // It IS a compact JWE: 5 dot-separated segments.
      expect(rawBytes.split('.')).toHaveLength(5);
    } finally {
      await new Promise<void>((resolve) => raw.close(() => resolve()));
    }
  });

  it('non-2xx response surfaces as a thrown error', async () => {
    const failing = createServer((_req, res) => {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('upstream down');
    });
    await new Promise<void>((resolve) => failing.listen(0, '127.0.0.1', resolve));
    const addr = failing.address() as AddressInfo;
    try {
      const adapter = buildAdapter({
        url: `http://127.0.0.1:${addr.port}`,
        participantPriv: participant.privatePem,
        gatewayPub: gateway.publicPem,
      });

      await expect(
        adapter.verifyEligibility({
          tenantId: 'tenant-1',
          claimId: 'claim-1',
          hospitalMrn: 'MRN-FAIL',
          patientName: 'Patient',
        }),
      ).rejects.toThrow(/HTTP 503/);
    } finally {
      await new Promise<void>((resolve) => failing.close(() => resolve()));
    }
  });
});
