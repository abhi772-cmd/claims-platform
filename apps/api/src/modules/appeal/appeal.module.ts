import { Module } from '@nestjs/common';

import { AppealController } from './appeal.controller';
import { AppealService } from './appeal.service';
import { CaseModule } from '../case';
import { ClaimModule } from '../claim';

@Module({
  imports: [ClaimModule, CaseModule],
  controllers: [AppealController],
  providers: [AppealService],
  exports: [AppealService],
})
export class AppealModule {}
