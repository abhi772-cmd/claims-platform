import { Module } from '@nestjs/common';

import { EligibilityController } from './eligibility.controller';
import { EligibilityService } from './eligibility.service';
import { NhcxStubAdapter } from './nhcx-stub.adapter';
import { CaseModule } from '../case';
import { ClaimModule } from '../claim';

@Module({
  imports: [ClaimModule, CaseModule],
  controllers: [EligibilityController],
  providers: [EligibilityService, NhcxStubAdapter],
  exports: [EligibilityService],
})
export class EligibilityModule {}
