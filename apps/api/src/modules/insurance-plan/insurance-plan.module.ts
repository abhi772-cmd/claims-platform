import { Module } from '@nestjs/common';

import { InsurancePlanController } from './insurance-plan.controller';
import { InsurancePlanService } from './insurance-plan.service';
import { CaseModule } from '../case';
import { IntegrationModule } from '../integration';

// NhcxModule is @Global so we don't import it here — the service
// injects NHCX_ADAPTER directly. CaseModule is needed for the
// controller's claim-ownership check; IntegrationModule for the
// ledger writer used inside the service.
@Module({
  imports: [CaseModule, IntegrationModule],
  controllers: [InsurancePlanController],
  providers: [InsurancePlanService],
  exports: [InsurancePlanService],
})
export class InsurancePlanModule {}
