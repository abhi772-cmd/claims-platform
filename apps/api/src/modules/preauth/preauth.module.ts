import { Module } from '@nestjs/common';

import { PreauthController } from './preauth.controller';
import { PreauthService } from './preauth.service';
import { CaseModule } from '../case';
import { ClaimModule } from '../claim';
import { EligibilityModule } from '../eligibility';

// EligibilityModule is imported only to share NhcxStubAdapter. Slice P
// will rename + extract the adapter into its own module since it's
// shared across phases (eligibility, preauth, claim submit).
@Module({
  imports: [ClaimModule, CaseModule, EligibilityModule],
  controllers: [PreauthController],
  providers: [PreauthService],
  exports: [PreauthService],
})
export class PreauthModule {}
