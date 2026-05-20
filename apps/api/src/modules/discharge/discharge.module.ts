import { Module } from '@nestjs/common';

import { BillExtractController } from './bill-extract.controller';
import { BillExtractService } from './bill-extract.service';
import { DischargeController } from './discharge.controller';
import { DischargeService } from './discharge.service';
import { NonMedicalClassifierController } from './non-medical-classifier.controller';
import { BillOcrModule } from '../bill-ocr';
import { CaseModule } from '../case';
import { ClaimModule } from '../claim';
import { DocumentModule } from '../document';

@Module({
  imports: [ClaimModule, CaseModule, DocumentModule, BillOcrModule],
  // NonMedicalClassifierController + BillExtractController are
  // stateless discharge-flow tooling. The classifier is a pure
  // utility (no injection); BillExtractController forwards uploaded
  // bill bytes to the bill-OCR adapter via BillExtractService.
  controllers: [DischargeController, NonMedicalClassifierController, BillExtractController],
  providers: [DischargeService, BillExtractService],
  exports: [DischargeService],
})
export class DischargeModule {}
