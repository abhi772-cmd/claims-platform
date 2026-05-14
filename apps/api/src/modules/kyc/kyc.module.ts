import { Module } from '@nestjs/common';

import { KycReviewController } from './kyc-review.controller';
import { KycController } from './kyc.controller';
import { KycService } from './kyc.service';

// StorageModule + AuditModule are @Global, so KycService can inject
// STORAGE_ADAPTER and AuditService without an explicit import here.
@Module({
  controllers: [KycController, KycReviewController],
  providers: [KycService],
  exports: [KycService],
})
export class KycModule {}
