import { Module } from '@nestjs/common';

import { BackupCodeService } from './backup-code.service';
import { MfaService } from './mfa.service';
import { TotpService } from './totp.service';

// MfaService is exported so AuthModule (login → challenge → verify) and
// the controller for /auth/me/mfa/* can depend on it. AuditService is
// global. PrismaService is global.
@Module({
  providers: [TotpService, BackupCodeService, MfaService],
  exports: [TotpService, BackupCodeService, MfaService],
})
export class MfaModule {}
