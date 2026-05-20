import { Module } from '@nestjs/common';

import { TenantPayerController } from './tenant-payer.controller';
import { TenantPayerService } from './tenant-payer.service';

@Module({
  controllers: [TenantPayerController],
  providers: [TenantPayerService],
  exports: [TenantPayerService],
})
export class TenantPayerModule {}
