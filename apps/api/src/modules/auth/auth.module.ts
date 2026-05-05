import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MfaModule } from '../mfa';
import { PasswordModule } from '../password';
import { AppSecurityModule } from '../security';
import { TenantModule } from '../tenant/tenant.module';
import { UserModule } from '../user/user.module';

// JwtModule, Passport, JwtStrategy, JwtAuthGuard, RolesGuard are provided
// by the global SecurityModule (see common/security/security.module.ts).
// AppSecurityModule (IP allowlist, sessions, trusted devices) is the
// application-level security module — separate concept.
@Module({
  imports: [UserModule, TenantModule, PasswordModule, MfaModule, AppSecurityModule],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
