import { Module } from '@nestjs/common';

import { DischargeController } from './discharge.controller';
import { DischargeService } from './discharge.service';
import { CaseModule } from '../case';
import { ClaimModule } from '../claim';
import { DocumentModule } from '../document';

@Module({
  imports: [ClaimModule, CaseModule, DocumentModule],
  controllers: [DischargeController],
  providers: [DischargeService],
  exports: [DischargeService],
})
export class DischargeModule {}
