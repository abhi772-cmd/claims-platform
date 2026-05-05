import 'reflect-metadata';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { type NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { DomainExceptionFilter } from './common/filters/domain-exception.filter';
import { type AppConfig } from './config/configuration';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
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

  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  app.get(Logger).log(`Claims API listening on :${String(port)}`);
}

void bootstrap();
