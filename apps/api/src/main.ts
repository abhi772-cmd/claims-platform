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

// P0.7 — PMJAY InsurancePlan bundles routinely run 20+ MB once package
// master + STG QuestionnaireResponse + 24 Claim-Condition extensions
// land in a single insurance-plan/on_search callback. Default Express
// limit (100 kB) would reject those at the wire layer before the
// inbound controller ever sees them. We pick 30 MB so a 25 MB callback
// has 20 % headroom and ops doesn't have to bump again when payers
// add new specialties. NHCX outbound bundles (we send) stay tiny —
// the bump only matters for inbound.
const NHCX_BODY_LIMIT = '30mb';

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

  // P0.7 — override the default 100 kB JSON limit. We use Nest 10's
  // `useBodyParser` so we replace the built-in parser instead of
  // stacking a second one (which deadlocks since both try to consume
  // the request stream). rawBody capture is preserved by Nest because
  // we kept `rawBody: true` on NestFactory.create.
  app.useBodyParser('json', { limit: NHCX_BODY_LIMIT });
  app.useBodyParser('urlencoded', { limit: NHCX_BODY_LIMIT, extended: true });

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
