import { Module } from '@nestjs/common';

import { PreauthController } from './preauth.controller';
import { PreauthService } from './preauth.service';
import { CaseModule } from '../case';
import { ClaimModule } from '../claim';
import { TenantModule } from '../tenant/tenant.module';

// BiometricAuthModule + NhcxModule are @Global — no explicit import
// needed for their adapters / services.
@Module({
  imports: [ClaimModule, CaseModule, TenantModule],
  controllers: [PreauthController],
  providers: [PreauthService],
  exports: [PreauthService],
})
export class PreauthModule {}
