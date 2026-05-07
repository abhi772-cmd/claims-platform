import 'reflect-metadata';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { type NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { DomainExceptionFilter } from './common/filters/domain-exception.filter';
import { type AppConfig } from './config/configuration';
import { mountOpenApi } from './openapi';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // Slice AO — the NHCX inbound signature guard verifies the gateway's
    // HTTP Signature against the SHA-256 digest of the *raw* body, so we
    // need access to the original byte-for-byte bytes, not the parsed
    // JSON. NestExpressApplication exposes them as `req.rawBody` when
    // this option is set.
    rawBody: true,
  });

  app.useLogger(app.get(Logger));
  app.use(cookieParser());
  app.useGlobalFilters(new DomainExceptionFilter());

  // Strip the identifying X-Powered-By header at the Express level.
  // The security-headers middleware also removes it per response as
  // belt-and-brace coverage.
  app.disable('x-powered-by');

  const config = app.get(ConfigService<AppConfig, true>);
  app.enableCors({
    origin: config.get('CORS_ORIGIN', { infer: true }),
    credentials: true,
  });

  // Mount the OpenAPI spec + Swagger UI under /api/docs. Off by
  // default in production until ops decides whether to expose it
  // publicly or behind an internal-only ingress (see SWAGGER_ENABLED).
  mountOpenApi(app, config);

  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  app.get(Logger).log(`Claims API listening on :${String(port)}`);
}

void bootstrap();
