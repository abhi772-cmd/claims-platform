import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { JwtStrategy } from './jwt.strategy.js';
import { type AppConfig } from '../../config/configuration.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { UserModule } from '../user/user.module.js';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        privateKey: config.get('jwtPrivateKeyPem', { infer: true }),
        publicKey: config.get('jwtPublicKeyPem', { infer: true }),
        signOptions: {
          algorithm: 'RS256',
          expiresIn: config.get('JWT_ACCESS_TTL', { infer: true }),
          issuer: config.get('JWT_ISSUER', { infer: true }),
          audience: config.get('JWT_AUDIENCE', { infer: true }),
        },
        verifyOptions: {
          algorithms: ['RS256'],
          issuer: config.get('JWT_ISSUER', { infer: true }),
          audience: config.get('JWT_AUDIENCE', { infer: true }),
        },
      }),
    }),
    UserModule,
    TenantModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, JwtAuthGuard],
  exports: [AuthService, JwtAuthGuard],
})
export class AuthModule {}
