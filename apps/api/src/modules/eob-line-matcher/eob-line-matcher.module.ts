import { Module } from '@nestjs/common';

import { EobLineMatcherController } from './eob-line-matcher.controller';
import { EobLineMatcherService } from './eob-line-matcher.service';
import { BillLineItemModule } from '../bill-line-item/bill-line-item.module';
import { CaseModule } from '../case';
import { SettlementModule } from '../settlement/settlement.module';

@Module({
  imports: [BillLineItemModule, SettlementModule, CaseModule],
  controllers: [EobLineMatcherController],
  providers: [EobLineMatcherService],
  exports: [EobLineMatcherService],
})
export class EobLineMatcherModule {}
