import { Module } from '@nestjs/common';

import { EligibilityController } from './eligibility.controller';
import { EligibilityService } from './eligibility.service';
import { NhcxStubAdapter } from './nhcx-stub.adapter';
import { CaseModule } from '../case';
import { ClaimModule } from '../claim';

// NhcxStubAdapter is exported because PreauthModule shares it. Slice P
// will extract the adapter into its own module once multiple phases
// (eligibility, preauth, claim submit) all depend on it.
@Module({
  imports: [ClaimModule, CaseModule],
  controllers: [EligibilityController],
  providers: [EligibilityService, NhcxStubAdapter],
  exports: [EligibilityService, NhcxStubAdapter],
})
export class EligibilityModule {}
