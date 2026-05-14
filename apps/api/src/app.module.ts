import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { SecurityHeadersMiddleware } from './common/middleware/security-headers.middleware';
import { PrismaModule } from './common/prisma/prisma.module';
import { SecurityModule } from './common/security/security.module';
import { loadConfig } from './config/configuration';
import { AppealModule } from './modules/appeal';
import { AuditModule } from './modules/audit';
import { AuthModule } from './modules/auth/auth.module';
import { BiometricAuthModule } from './modules/biometric-auth';
import { BreachModule } from './modules/breach/breach.module';
import { CaseModule } from './modules/case';
import { ClaimModule } from './modules/claim';
import { ClaimSubmitModule } from './modules/claim-submit';
import { ComplianceModule } from './modules/compliance/compliance.module';
import { ConsentModule } from './modules/consent/consent.module';
import { DataAccessModule } from './modules/data-access/data-access.module';
import { DischargeModule } from './modules/discharge';
import { DoctorModule } from './modules/doctor';
import { DocumentModule } from './modules/document';
import { VirusScanModule } from './modules/document/scan';
import { EligibilityModule } from './modules/eligibility';
import { EobOcrModule } from './modules/eob-ocr';
import { ErasureModule } from './modules/erasure/erasure.module';
import { HealthModule } from './modules/health/health.module';
import { HprModule } from './modules/hpr';
import { InsurancePlanModule } from './modules/insurance-plan';
import { IntegrationModule } from './modules/integration';
import { MasterDataModule } from './modules/master-data';
import { MfaModule } from './modules/mfa';
import { NhcxModule } from './modules/nhcx';
import { NhcxInboundModule } from './modules/nhcx/inbound/nhcx-inbound.module';
import { NotificationModule } from './modules/notification';
import { OnboardingModule } from './modules/onboarding';
import { PasswordModule } from './modules/password';
import { PatientModule } from './modules/patient';
import { PayerExtractorsModule } from './modules/payer-extractors/payer-extractors.module';
import { PmjayPoliciesModule } from './modules/pmjay-policies';
import { PreauthModule } from './modules/preauth';
import { AppSecurityModule } from './modules/security';
import { SettlementModule } from './modules/settlement';
import { StorageModule } from './modules/storage';
import { TenantModule } from './modules/tenant/tenant.module';
import { UserModule } from './modules/user/user.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Disable Nest's own dotenv loader and use loadConfig as the single source
      // of truth so config.get() returns the Zod-parsed typed values
      // (e.g. boolean false), not raw strings from process.env.
      ignoreEnvFile: true,
      ignoreEnvVars: true,
      load: [() => loadConfig(process.env)],
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env['LOG_LEVEL'] ?? 'info',
        // PII redaction. Add new sensitive paths here as the surface grows.
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'res.headers["set-cookie"]',
            '*.password',
            '*.passwordHash',
            '*.refreshToken',
            '*.accessToken',
            '*.aadhaar',
            '*.abhaId',
            '*.policyNumber',
            '*.mobile',
            '*.email',
            '*.mfaSecret',
          ],
          censor: '[redacted]',
        },
        transport:
          process.env['NODE_ENV'] === 'development'
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
      },
    }),
    PrismaModule,
    SecurityModule,
    AuditModule,
    DataAccessModule,
    NotificationModule,
    PasswordModule,
    MfaModule,
    AppSecurityModule,
    HprModule,
    DoctorModule,
    OnboardingModule,
    IntegrationModule,
    NhcxModule,
    NhcxInboundModule,
    StorageModule,
    VirusScanModule,
    EobOcrModule,
    BiometricAuthModule,
    PatientModule,
    ClaimModule,
    CaseModule,
    EligibilityModule,
    InsurancePlanModule,
    PreauthModule,
    PmjayPoliciesModule,
    DocumentModule,
    DischargeModule,
    ClaimSubmitModule,
    SettlementModule,
    AppealModule,
    MasterDataModule,
    HealthModule,
    TenantModule,
    UserModule,
    AuthModule,
    ErasureModule,
    BreachModule,
    ConsentModule,
    ComplianceModule,
    PayerExtractorsModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Security headers run on every request, including health checks.
    // Mounting at '*' covers all routes registered after AppModule.
    consumer.apply(SecurityHeadersMiddleware).forRoutes('*');
  }
}
