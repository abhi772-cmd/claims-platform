// Smoke test — exercises mountOpenApi against a stripped-down NestJS
// app. We're not booting the full AppModule (which needs Postgres);
// the goal here is to assert:
//   1. The /api/docs-json route is registered when SWAGGER_ENABLED=true
//      and serves a structurally valid OpenAPI 3 document.
//   2. The route is NOT registered when SWAGGER_ENABLED=false.
//   3. The document advertises the cookie-auth security scheme so the
//      Swagger UI's "Authorize" button does the right thing.

import { Controller, Get, type INestApplication, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { type AppConfig } from './config/configuration';
import { mountOpenApi } from './openapi';

@Controller('ping')
class PingController {
  @Get()
  ping(): { ok: true } {
    return { ok: true };
  }
}

@Module({
  controllers: [PingController],
})
class PingModule {}

async function bootApp(swaggerEnabled: boolean): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        ignoreEnvVars: true,
        // Hand-rolled load function that returns just the SWAGGER_ENABLED
        // value the test cares about — we don't want to drag in the
        // full env schema (which requires JWT / DB / etc.).
        load: [(): Partial<AppConfig> => ({ SWAGGER_ENABLED: swaggerEnabled } as Partial<AppConfig>)],
      }),
      PingModule,
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  const config = app.get<ConfigService<AppConfig, true>>(ConfigService);
  mountOpenApi(app, config);
  await app.init();
  return app;
}

describe('OpenAPI mount', () => {
  it('serves a valid OpenAPI 3 document at /api/docs-json when enabled', async () => {
    const app = await bootApp(true);
    try {
      const res = await request(app.getHttpServer()).get('/api/docs-json');
      expect(res.status).toBe(200);
      expect(res.body.openapi).toMatch(/^3\./);
      expect(res.body.info.title).toBe('DigiSparsh Claims Platform API');
      expect(res.body.info.version).toBe('0.1.0');
      // Cookie auth scheme is declared. Different versions of
      // @nestjs/swagger key the scheme either by the cookie name or
      // by 'cookie' — accept either by inspecting all schemes.
      const schemes = (res.body.components?.securitySchemes ?? {}) as Record<
        string,
        { type?: string; in?: string; name?: string }
      >;
      const cookieScheme = Object.values(schemes).find(
        (s) => s.type === 'apiKey' && s.in === 'cookie' && s.name === 'claims_at',
      );
      expect(cookieScheme).toBeDefined();
      // The PingController route showed up — proves the auto-discovery
      // walks all registered controllers.
      expect(res.body.paths['/ping']).toBeDefined();
      expect(res.body.paths['/ping'].get).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it('returns 404 on /api/docs-json when SWAGGER_ENABLED=false', async () => {
    const app = await bootApp(false);
    try {
      const res = await request(app.getHttpServer()).get('/api/docs-json');
      expect(res.status).toBe(404);
    } finally {
      await app.close();
    }
  });
});
