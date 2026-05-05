// Slice Q integration test — production deploy slice.
//
//   1. /health/live always returns 200 + status:ok
//   2. /health/ready reports database + migrations + adapter modes +
//      build provenance.
//   3. Security headers are present on every response (including health
//      endpoints).

import { generateKeyPairSync } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { startPostgres, type PgHandles } from '../setup/postgres-container';

jest.setTimeout(180_000);

describe('Slice Q — /health/* + security headers', () => {
  let pg: PgHandles;
  let app: INestApplication;
  let migrator: PrismaClient;

  beforeAll(async () => {
    pg = await startPostgres();
    migrator = new PrismaClient({ datasources: { db: { url: pg.migratorUrl } } });

    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env['NODE_ENV'] = 'test';
    process.env['MODE'] = 'api';
    process.env['PORT'] = '0';
    process.env['DATABASE_URL'] = pg.appUrl;
    process.env['DATABASE_URL_MIGRATOR'] = pg.migratorUrl;
    process.env['JWT_PRIVATE_KEY_BASE64'] = Buffer.from(
      privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    ).toString('base64');
    process.env['JWT_PUBLIC_KEY_BASE64'] = Buffer.from(
      publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    ).toString('base64');
    process.env['LOG_LEVEL'] = 'warn';
    process.env['CORS_ORIGIN'] = 'http://localhost:3000';
    process.env['WEB_BASE_URL'] = 'http://localhost:3000';
    process.env['SMTP_HOST'] = '127.0.0.1';
    process.env['SMTP_PORT'] = '1';
    process.env['SMTP_FROM'] = 'no-reply@test';
    process.env['NOTIFICATION_RETRY_DISABLED'] = 'true';
    process.env['NHCX_MODE'] = 'stub';
    process.env['HPR_MODE'] = 'stub';
    process.env['STORAGE_MODE'] = 'stub';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.use(cookieParser());
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await migrator.$disconnect().catch(() => undefined);
    await pg.shutdown();
  });

  it('/health/live → 200 ok', async () => {
    const r = await request(app.getHttpServer()).get('/health/live');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ok');
  });

  it('/health/ready reports database, migrations, adapter modes, build', async () => {
    const r = await request(app.getHttpServer()).get('/health/ready');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ok');
    expect(r.body.checks.database).toBe(true);
    expect(r.body.checks.migrations).toBe(true);
    expect(r.body.adapters).toEqual({ nhcx: 'stub', hpr: 'stub', storage: 'stub' });
    expect(r.body.build).toEqual(
      expect.objectContaining({
        commit: expect.any(String),
        builtAt: expect.any(String),
      }),
    );
  });

  it('security headers are present on health responses', async () => {
    const r = await request(app.getHttpServer()).get('/health/live');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['permissions-policy']).toContain('camera=()');
    // X-Powered-By must be stripped
    expect(r.headers['x-powered-by']).toBeUndefined();
  });

  it('security headers are present on application responses too', async () => {
    // /auth/login on a non-existent user is a fine probe — it returns
    // an error but the response still flows through the middleware.
    const r = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: 'wrong' });
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });
});
