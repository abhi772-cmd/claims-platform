import { Module } from '@nestjs/common';

import { AppealController } from './appeal.controller';
import { AppealService } from './appeal.service';
import { CaseModule } from '../case';
import { ClaimModule } from '../claim';
import { SettlementModule } from '../settlement';

@Module({
  imports: [ClaimModule, CaseModule, SettlementModule],
  controllers: [AppealController],
  providers: [AppealService],
  exports: [AppealService],
})
export class AppealModule {}
