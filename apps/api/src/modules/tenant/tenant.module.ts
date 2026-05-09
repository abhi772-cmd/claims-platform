import { Module } from '@nestjs/common';

import { TenantConsentController } from './tenant-consent.controller';
import { TenantService } from './tenant.service';

@Module({
  controllers: [TenantConsentController],
  providers: [TenantService],
  exports: [TenantService],
})
export class TenantModule {}
