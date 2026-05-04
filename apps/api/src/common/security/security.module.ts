import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { type AppConfig } from '../../config/configuration';
import { JwtAuthGuard } from '../../modules/auth/jwt-auth.guard';
import { JwtStrategy } from '../../modules/auth/jwt.strategy';
import { RolesGuard } from '../guards/roles.guard';

// Shared security primitives — JwtModule, Passport, JwtStrategy, JwtAuthGuard,
// RolesGuard. Marked @Global so any module can @UseGuards(JwtAuthGuard, RolesGuard)
// without an explicit import. Extracted out of AuthModule to break the circular
// dependency between AuthModule and UserModule.
@Global()
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
  ],
  providers: [JwtStrategy, JwtAuthGuard, RolesGuard],
  exports: [JwtModule, PassportModule, JwtAuthGuard, RolesGuard],
})
export class SecurityModule {}
