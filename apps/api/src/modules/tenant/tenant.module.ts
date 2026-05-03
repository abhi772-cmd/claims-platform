import { Module } from '@nestjs/common';

import { TenantService } from './tenant.service.js';

@Module({
  providers: [TenantService],
  exports: [TenantService],
})
export class TenantModule {}
