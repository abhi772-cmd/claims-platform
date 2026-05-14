import { Module } from '@nestjs/common';

import { NhcxInboundRateLimitGuard } from './nhcx-inbound-rate-limit.guard';
import { NhcxInboundSignatureGuard } from './nhcx-inbound-signature.guard';
import { NhcxInboundController } from './nhcx-inbound.controller';
import { NhcxInboundService } from './nhcx-inbound.service';
import { NhcxSenderAllowlistService } from './nhcx-sender-allowlist.service';
import { ClaimSubmitModule } from '../../claim-submit/claim-submit.module';
import { DischargeModule } from '../../discharge/discharge.module';
import { EligibilityModule } from '../../eligibility/eligibility.module';
import { InsurancePlanModule } from '../../insurance-plan/insurance-plan.module';
import { PreauthModule } from '../../preauth/preauth.module';
import { SettlementModule } from '../../settlement/settlement.module';
import { TenantModule } from '../../tenant/tenant.module';

// NhcxModule (the global one) supplies NHCX_KEY_RESOLVER + crypto +
// adapter. IntegrationModule is global so IntegrationMessageService is
// available without an explicit import. We pull in the phase modules
// whose services receive parsed callbacks — Slice BC adds
// SettlementModule for the paymentnotice/request handler. Slice BM
// adds TenantModule so the dispatcher can read pmjayMode for the
// FHIR-validator misroute warnings.
@Module({
  imports: [
    EligibilityModule,
    PreauthModule,
    ClaimSubmitModule,
    DischargeModule,
    SettlementModule,
    TenantModule,
    InsurancePlanModule,
  ],
  controllers: [NhcxInboundController],
  providers: [
    NhcxInboundService,
    NhcxSenderAllowlistService,
    NhcxInboundSignatureGuard,
    NhcxInboundRateLimitGuard,
  ],
  exports: [NhcxInboundService, NhcxSenderAllowlistService],
})
export class NhcxInboundModule {}
