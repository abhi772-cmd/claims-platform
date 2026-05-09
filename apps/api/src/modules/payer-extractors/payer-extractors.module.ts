import { Global, Module } from '@nestjs/common';

import { BajajAllianzExtractor } from './bajaj-allianz.extractor';
import { PAYER_EXTRACTORS } from './payer-extractor.interface';
import { PayerExtractorService } from './payer-extractor.service';
import { StarHealthExtractor } from './star-health.extractor';

// @Global so the registry can be injected from any module that
// already consumes the OCR adapter (DocumentService today; future
// settlement-draft service when auto-fill lands).
//
// Registry order matters when two extractors might both match — the
// first true wins. Today's two extractors are mutually exclusive
// (different ref-number prefixes + name signatures); when adding
// new payers, list narrower / more distinctive payers before the
// generic-leaning ones.
@Global()
@Module({
  providers: [
    StarHealthExtractor,
    BajajAllianzExtractor,
    {
      provide: PAYER_EXTRACTORS,
      useFactory: (
        star: StarHealthExtractor,
        bajaj: BajajAllianzExtractor,
      ) => [star, bajaj] as const,
      inject: [StarHealthExtractor, BajajAllianzExtractor],
    },
    PayerExtractorService,
  ],
  exports: [PayerExtractorService],
})
export class PayerExtractorsModule {}

export { PayerExtractorService } from './payer-extractor.service';
export {
  PAYER_CODES,
  DEDUCTION_CATEGORIES,
  type PayerCode,
  type DeductionCategory,
} from './payer-extractor.interface';
