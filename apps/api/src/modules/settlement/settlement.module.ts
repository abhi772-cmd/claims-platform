import { Module } from '@nestjs/common';

import { SettlementController } from './settlement.controller';
import { SettlementService } from './settlement.service';
import { CaseModule } from '../case';
import { ClaimModule } from '../claim';

@Module({
  imports: [ClaimModule, CaseModule],
  controllers: [SettlementController],
  providers: [SettlementService],
  exports: [SettlementService],
})
export class SettlementModule {}
