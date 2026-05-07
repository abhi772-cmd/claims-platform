import { Module } from '@nestjs/common';

import { NhcxInboundSignatureGuard } from './nhcx-inbound-signature.guard';
import { NhcxInboundController } from './nhcx-inbound.controller';
import { NhcxInboundService } from './nhcx-inbound.service';
import { NhcxSenderAllowlistService } from './nhcx-sender-allowlist.service';
import { ClaimSubmitModule } from '../../claim-submit/claim-submit.module';
import { DischargeModule } from '../../discharge/discharge.module';
import { EligibilityModule } from '../../eligibility/eligibility.module';
import { PreauthModule } from '../../preauth/preauth.module';

// NhcxModule (the global one) supplies NHCX_KEY_RESOLVER + crypto +
// adapter. IntegrationModule is global so IntegrationMessageService is
// available without an explicit import. We pull in the four phase
// modules whose services receive parsed callbacks.
@Module({
  imports: [EligibilityModule, PreauthModule, ClaimSubmitModule, DischargeModule],
  controllers: [NhcxInboundController],
  providers: [NhcxInboundService, NhcxSenderAllowlistService, NhcxInboundSignatureGuard],
  exports: [NhcxInboundService, NhcxSenderAllowlistService],
})
export class NhcxInboundModule {}
