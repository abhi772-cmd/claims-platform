import { type INestApplication } from '@nestjs/common';
import { type ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { type AppConfig } from './config/configuration';

// Mounts the OpenAPI spec at /api/docs-json and the Swagger UI at
// /api/docs. Gated by SWAGGER_ENABLED so production deployments can
// keep the docs route off (or off-on-the-public-edge) without code
// changes.
//
// The spec is built from controller decorators (@ApiTags, @ApiOperation,
// etc.) — we don't hand-author the YAML. This keeps the docs honest
// against the route surface and lets CI catch drift via the
// /api/docs-json snapshot test.
//
// Auth: every authenticated route uses the `claims_at` cookie. Add a
// global cookie-auth security scheme so the "Authorize" button in the
// Swagger UI does the right thing.
export function mountOpenApi(
  app: INestApplication,
  config: ConfigService<AppConfig, true>,
): void {
  if (!config.get('SWAGGER_ENABLED', { infer: true })) return;

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('DigiSparsh Claims Platform API')
      .setDescription(
        'Multi-tenant NHCX + PMJAY claims processing API. Authentication is cookie-based (RS256 JWT in `claims_at`). Public routes: `/health/*`, `/auth/login`, `/auth/accept-invite`, `/auth/password-reset/*`, `/preauth/doctor-tokens/:rawToken/*` (doctor-sign flow), `/nhcx/inbound` (HCX gateway webhook). Everything else requires the cookie.',
      )
      .setVersion('0.1.0')
      .addCookieAuth('claims_at', { type: 'apiKey', in: 'cookie' })
      // Slice AK — friendly tags with descriptions. Each controller
      // carries an explicit @ApiTags() so the route grouping in the UI
      // matches these descriptions instead of falling back to the
      // controller class name. Order here drives the UI's tag order.
      .addTag('auth', 'Login, MFA, password reset, sessions, trusted devices')
      .addTag('tenant-onboarding', 'Onboarding wizard, readiness checks, lifecycle FSM')
      .addTag('tenant-security', 'IP allowlist + tenant security knobs')
      .addTag('tenant-comms-config', 'Per-tenant SMTP + SMS provider config')
      .addTag('tenant-users', 'User invitation + admin')
      .addTag('cases', 'Case + claim CRUD')
      .addTag('claims', 'Claim event timeline + manual transitions')
      .addTag('eligibility', 'NHCX eligibility verification')
      .addTag('preauth', 'Pre-auth draft, submit, query response')
      .addTag('discharge', 'Discharge initiation + submission')
      .addTag('claim-submission', 'Final claim submission')
      .addTag('settlement', 'Payment, EOB, reconciliation, write-off')
      .addTag('appeal', 'Appeal lifecycle (start, submit, resolve)')
      .addTag('documents', 'File upload + scan lifecycle')
      .addTag('audit', 'Audit log viewer + CSV export')
      .addTag('master-data', 'Payer / package / ICD / billing / checklist')
      .addTag('nhcx-inbound', 'HCX gateway webhook (public, JWE-authenticated)')
      .addTag('doctor', 'Doctor short-token sign flow (public)')
      .addTag('health', 'Liveness + readiness probes')
      .build(),
    {
      operationIdFactory: (controllerKey: string, methodKey: string): string =>
        `${controllerKey}_${methodKey}`,
    },
  );

  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs-json',
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'none',
    },
  });
}
