import { Module } from '@nestjs/common';

import { DischargeController } from './discharge.controller';
import { DischargeService } from './discharge.service';
import { NonMedicalClassifierController } from './non-medical-classifier.controller';
import { CaseModule } from '../case';
import { ClaimModule } from '../claim';
import { DocumentModule } from '../document';

@Module({
  imports: [ClaimModule, CaseModule, DocumentModule],
  // NonMedicalClassifierController is a stateless utility — no
  // service injection, no DB. Bundled into DischargeModule because
  // it's discharge-flow tooling.
  controllers: [DischargeController, NonMedicalClassifierController],
  providers: [DischargeService],
  exports: [DischargeService],
})
export class DischargeModule {}
