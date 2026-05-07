import { Module } from '@nestjs/common';

import { ClaimSubmitController } from './claim-submit.controller';
import { ClaimSubmitService } from './claim-submit.service';
import { CaseModule } from '../case';
import { ClaimModule } from '../claim';
import { DocumentModule } from '../document';
import { TenantModule } from '../tenant/tenant.module';

@Module({
  imports: [ClaimModule, CaseModule, DocumentModule, TenantModule],
  controllers: [ClaimSubmitController],
  providers: [ClaimSubmitService],
  exports: [ClaimSubmitService],
})
export class ClaimSubmitModule {}
