import { Module } from '@nestjs/common';

import { IpAllowlistService } from './ip-allowlist.service';
import { TenantSecurityController } from './security.controller';
import { SessionService } from './session.service';
import { TrustedDeviceService } from './trusted-device.service';

// Note: this is the *application* security module — IP allowlist + session
// + trusted device services. The infra-level SecurityModule under
// common/security/ is a different thing (JwtModule, RolesGuard etc.). We
// keep them separate because the latter is @Global() and the former
// doesn't need to be — it's only consumed by AuthModule.
@Module({
  controllers: [TenantSecurityController],
  providers: [IpAllowlistService, TrustedDeviceService, SessionService],
  exports: [IpAllowlistService, TrustedDeviceService, SessionService],
})
export class AppSecurityModule {}
