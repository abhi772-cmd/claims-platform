import { Module } from '@nestjs/common';

import { ClaimSubmitController } from './claim-submit.controller';
import { ClaimSubmitService } from './claim-submit.service';
import { CaseModule } from '../case';
import { ClaimModule } from '../claim';
import { EligibilityModule } from '../eligibility';

@Module({
  imports: [ClaimModule, CaseModule, EligibilityModule],
  controllers: [ClaimSubmitController],
  providers: [ClaimSubmitService],
  exports: [ClaimSubmitService],
})
export class ClaimSubmitModule {}
