// Slice AO integration — proves the HTTP Signature guard wires up
// correctly against a real NestExpressApplication boot, not just the
// pure verifier unit-tested elsewhere. Boots with
//   NHCX_INBOUND_VERIFY_SIGNATURE=true
// and a gateway pubkey under our control. Uses the matching gateway
// privkey to sign synthetic POSTs.
//
// Asserts:
//   1. A correctly signed request reaches the controller (200 + accept).
//   2. A request with no Signature header → 401.
//   3. A request with a tampered body (good signature, mismatched
//      digest because body bytes differ from what was signed) → 401.

import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { type Server } from 'node:http';

import { type INestApplication } from '@nestjs/common';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import {
  buildSigningString,
  computeDigest,
} from '../../src/modules/nhcx/inbound/http-signature';
import { startPostgres, type PgHandles } from '../setup/postgres-container';

jest.setTimeout(180_000);

interface SignedHeaders {
  date: string;
  digest: string;
  'x-hcx-correlation-id': string;
  'x-hcx-operation': string;
  signature: string;
  host: string;
}

function signGatewayRequest(opts: {
  body: Buffer;
  correlationId: string;
  operation: string;
  privateKeyPem: string;
  host: string;
}): SignedHeaders {
  const date = new Date().toUTCString();
  const digest = computeDigest(opts.body);
  const headers = {
    host: opts.host,
    date,
    digest,
    'x-hcx-correlation-id': opts.correlationId,
    'x-hcx-operation': opts.operation,
  };
  const signedNames = [
    '(request-target)',
    'host',
    'date',
    'digest',
    'x-hcx-correlation-id',
    'x-hcx-operation',
  ];
  const signingString = buildSigningString(signedNames, 'POST', '/nhcx/inbound', headers);
  if (signingString === null) throw new Error('test setup: signing string null');
  const signer = createSign('RSA-SHA256');
  signer.update(signingString);
  signer.end();
  const signature = signer.sign(opts.privateKeyPem).toString('base64');
  const sigHeader = [
    `keyId="gateway-v1"`,
    `algorithm="rsa-sha256"`,
    `headers="${signedNames.join(' ')}"`,
    `signature="${signature}"`,
  ].join(',');
  return { ...headers, signature: sigHeader };
}

describe('Slice AO — NHCX inbound HTTP signature guard', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;
  let gatewayPrivateKeyPem: string;
  // Host string used in both the signed signing-string AND the
  // actual `Host` header. supertest sends `Host: 127.0.0.1:<port>`
  // to the bound server regardless of what `.set('Host', ...)` says,
  // so we capture the real bound port post-listen and sign against
  // it. Without this match the signing string we reconstruct on the
  // server side differs by one byte (`host:`) and verification fails.
  let host: string;

  beforeAll(async () => {
    pg = await startPostgres();
    migrator = new PrismaClient({ datasources: { db: { url: pg.migratorUrl } } });

    const jwt = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const ours = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const gateway = generateKeyPairSync('rsa', { modulusLength: 2048 });
    gatewayPrivateKeyPem = gateway.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const gatewayPublicKeyPem = gateway.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();

    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'api';
    process.env['PORT'] = '0';
    process.env['DATABASE_URL'] = pg.appUrl;
    process.env['DATABASE_URL_MIGRATOR'] = pg.migratorUrl;
    process.env['JWT_PRIVATE_KEY_BASE64'] = Buffer.from(
      jwt.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    ).toString('base64');
    process.env['JWT_PUBLIC_KEY_BASE64'] = Buffer.from(
      jwt.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    ).toString('base64');
    process.env['LOG_LEVEL'] = 'warn';
    process.env['CORS_ORIGIN'] = 'http://localhost:3000';
    process.env['WEB_BASE_URL'] = 'http://localhost:3000';
    process.env['SMTP_HOST'] = '127.0.0.1';
    process.env['SMTP_PORT'] = '1';
    process.env['SMTP_FROM'] = 'no-reply@test';
    process.env['NOTIFICATION_RETRY_DISABLED'] = 'true';
    process.env['DOC_LIFECYCLE_DISABLED'] = 'true';

    process.env['NHCX_MODE'] = 'stub';
    process.env['NHCX_PRIVATE_KEY_BASE64'] = Buffer.from(
      ours.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    ).toString('base64');
    process.env['NHCX_PRIVATE_KEY_VERSION'] = 'v1';
    // Gateway pubkey serves both outbound JWE (existing usage) and
    // inbound signature verification (new in Slice AO).
    process.env['NHCX_GATEWAY_PUBLIC_KEY_BASE64'] = Buffer.from(gatewayPublicKeyPem).toString('base64');
    process.env['NHCX_INBOUND_VERIFY_SIGNATURE'] = 'true';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bufferLogs: true,
      // Mirrors the production main.ts so req.rawBody is populated.
      rawBody: true,
    });
    app.use(cookieParser());
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();

    // Bind the underlying http.Server so we can read its real port —
    // supertest will dial that same port and send `Host: 127.0.0.1:<port>`.
    const server = app.getHttpServer() as Server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') {
      throw new Error('server.address() did not return an AddressInfo');
    }
    host = `127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app?.close();
    await migrator.$disconnect().catch(() => undefined);
    await pg?.shutdown();
  });

  it('accepts a request with a valid HTTP signature', async () => {
    // Body needs to look like a JWE-shaped envelope so the Zod schema
    // on the controller is happy. The async dispatcher will error on
    // decrypt, but that doesn't affect the synchronous 200 we're
    // asserting against — the guard runs before validation.
    const correlationId = randomUUID();
    const body = Buffer.from(
      JSON.stringify({ payload: 'eyJhbGciOiJSU0EtT0FFUC0yNTYifQ..ciphertext' }),
      'utf8',
    );
    const headers = signGatewayRequest({
      body,
      correlationId,
      operation: 'preauth/on_submit',
      privateKeyPem: gatewayPrivateKeyPem,
      host,
    });

    const res = await request(app.getHttpServer())
      .post('/nhcx/inbound')
.set('Date', headers.date)
      .set('Digest', headers.digest)
      .set('X-HCX-Correlation-Id', headers['x-hcx-correlation-id'])
      .set('X-HCX-Operation', headers['x-hcx-operation'])
      .set('Signature', headers.signature)
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'accepted', correlationId });
  });

  it('rejects with 401 when no Signature header is present', async () => {
    const correlationId = randomUUID();
    const body = Buffer.from(JSON.stringify({ payload: 'whatever' }), 'utf8');
    const res = await request(app.getHttpServer())
      .post('/nhcx/inbound')
.set('X-HCX-Correlation-Id', correlationId)
      .set('X-HCX-Operation', 'preauth/on_submit')
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(401);
  });

  it('rejects with 401 when the body is tampered after signing', async () => {
    const correlationId = randomUUID();
    const signedBody = Buffer.from(JSON.stringify({ payload: 'original' }), 'utf8');
    const tamperedBody = Buffer.from(JSON.stringify({ payload: 'tampered' }), 'utf8');
    const headers = signGatewayRequest({
      body: signedBody,
      correlationId,
      operation: 'preauth/on_submit',
      privateKeyPem: gatewayPrivateKeyPem,
      host,
    });
    const res = await request(app.getHttpServer())
      .post('/nhcx/inbound')
.set('Date', headers.date)
      // Digest is the one bound to signedBody, but we send tamperedBody.
      .set('Digest', headers.digest)
      .set('X-HCX-Correlation-Id', headers['x-hcx-correlation-id'])
      .set('X-HCX-Operation', headers['x-hcx-operation'])
      .set('Signature', headers.signature)
      .set('Content-Type', 'application/json')
      .send(tamperedBody);
    expect(res.status).toBe(401);
  });

  it('rejects with 401 when the signature is signed by a different key', async () => {
    const correlationId = randomUUID();
    const body = Buffer.from(JSON.stringify({ payload: 'pretender' }), 'utf8');
    // Sign with an unrelated key the server has no knowledge of.
    const impostor = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const impostorPriv = impostor.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const headers = signGatewayRequest({
      body,
      correlationId,
      operation: 'preauth/on_submit',
      privateKeyPem: impostorPriv,
      host,
    });
    const res = await request(app.getHttpServer())
      .post('/nhcx/inbound')
.set('Date', headers.date)
      .set('Digest', headers.digest)
      .set('X-HCX-Correlation-Id', headers['x-hcx-correlation-id'])
      .set('X-HCX-Operation', headers['x-hcx-operation'])
      .set('Signature', headers.signature)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(401);
  });
});
