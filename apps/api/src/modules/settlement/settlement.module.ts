import { Module } from '@nestjs/common';

import { RemittanceController } from './remittance.controller';
import { RemittanceService } from './remittance.service';
import { SettlementController } from './settlement.controller';
import { SettlementService } from './settlement.service';
import { CaseModule } from '../case';
import { ClaimModule } from '../claim';

@Module({
  imports: [ClaimModule, CaseModule],
  controllers: [SettlementController, RemittanceController],
  providers: [SettlementService, RemittanceService],
  exports: [SettlementService, RemittanceService],
})
export class SettlementModule {}
