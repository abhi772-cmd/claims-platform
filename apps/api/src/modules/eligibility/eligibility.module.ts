import { Module } from '@nestjs/common';

import { EligibilityController } from './eligibility.controller';
import { EligibilityService } from './eligibility.service';
import { CaseModule } from '../case';
import { ClaimModule } from '../claim';

// NhcxModule is @Global so we don't need to import it here. Same for
// the other phase modules (preauth, discharge, claim-submit) — they all
// inject NHCX_ADAPTER directly.
@Module({
  imports: [ClaimModule, CaseModule],
  controllers: [EligibilityController],
  providers: [EligibilityService],
  exports: [EligibilityService],
})
export class EligibilityModule {}
