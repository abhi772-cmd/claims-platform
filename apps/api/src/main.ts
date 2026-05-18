import 'reflect-metadata';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { type NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { json, raw } from 'express';
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
const NHCX_BODY_LIMIT_BYTES = 30 * 1024 * 1024;

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
  // P0.7 — override the default 100 kB JSON limit with NHCX_BODY_LIMIT_BYTES
  // so large PMJAY callbacks (insurance-plan/on_search, payment-reconciliation
  // detail[]) clear the parser. The `raw` parser keeps `req.rawBody` available
  // to the inbound signature guard at the same higher limit.
  app.use(
    json({
      limit: NHCX_BODY_LIMIT_BYTES,
      // We piggy-back the raw-body capture the inbound signature guard
      // relies on. NestExpressApplication's `rawBody: true` option
      // would normally handle this, but it sets the limit to the
      // express default (100 kB) which is too low for PMJAY callbacks
      // — so we replace the parser entirely with one at the larger
      // limit + the same rawBody capture semantics.
      verify: (req, _res, buf) => {
        if (buf.length > 0) {
          (req as unknown as { rawBody: Buffer }).rawBody = buf;
        }
      },
    }),
  );
  app.use(raw({ limit: NHCX_BODY_LIMIT_BYTES, type: 'application/jose' }));
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
