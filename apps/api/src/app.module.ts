import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { PrismaModule } from './common/prisma/prisma.module';
import { loadConfig } from './config/configuration';
import { AuditModule } from './modules/audit';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
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
    AuditModule,
    HealthModule,
    TenantModule,
    UserModule,
    AuthModule,
  ],
})
export class AppModule {}
