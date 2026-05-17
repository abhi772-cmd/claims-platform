import { Module } from '@nestjs/common';

import { InsurancePlanController } from './insurance-plan.controller';
import { InsurancePlanService } from './insurance-plan.service';
import { CaseModule } from '../case';

@Module({
  imports: [CaseModule],
  controllers: [InsurancePlanController],
  providers: [InsurancePlanService],
  exports: [InsurancePlanService],
})
export class InsurancePlanModule {}
