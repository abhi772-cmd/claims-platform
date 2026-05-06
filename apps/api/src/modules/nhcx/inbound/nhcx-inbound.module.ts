import { Module } from '@nestjs/common';

import { NhcxInboundController } from './nhcx-inbound.controller';
import { NhcxInboundService } from './nhcx-inbound.service';
import { ClaimSubmitModule } from '../../claim-submit/claim-submit.module';
import { EligibilityModule } from '../../eligibility/eligibility.module';
import { PreauthModule } from '../../preauth/preauth.module';

// NhcxModule (the global one) supplies NHCX_KEY_RESOLVER + crypto +
// adapter. IntegrationModule is global so IntegrationMessageService is
// available without an explicit import. We pull in the three phase
// modules whose services receive parsed callbacks.
@Module({
  imports: [EligibilityModule, PreauthModule, ClaimSubmitModule],
  controllers: [NhcxInboundController],
  providers: [NhcxInboundService],
  exports: [NhcxInboundService],
})
export class NhcxInboundModule {}
