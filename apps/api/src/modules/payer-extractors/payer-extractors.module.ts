import { Global, Module } from '@nestjs/common';

import { BajajAllianzExtractor } from './bajaj-allianz.extractor';
import { HdfcErgoExtractor } from './hdfc-ergo.extractor';
import { IciciLombardExtractor } from './icici-lombard.extractor';
import { MediassistExtractor } from './mediassist.extractor';
import { ParamountExtractor } from './paramount.extractor';
import { PAYER_EXTRACTORS } from './payer-extractor.interface';
import { PayerExtractorService } from './payer-extractor.service';
import { StarHealthExtractor } from './star-health.extractor';

// @Global so the registry can be injected from any module that
// already consumes the OCR adapter (DocumentService today; future
// settlement-draft service when auto-fill lands).
//
// Registry order matters when two extractors might both match —
// the first true wins. Today's six extractors are mutually
// exclusive on the claim-ref prefix axis (each payer has its own
// distinctive prefixes) and the name-regex axis. When adding new
// payers, list narrower / more distinctive payers ahead of more
// generic-leaning ones.
//
// Slice CA shipped: Star Health, Bajaj Allianz.
// Slice CE adds:    ICICI Lombard, HDFC Ergo, Mediassist, Paramount.
@Global()
@Module({
  providers: [
    StarHealthExtractor,
    BajajAllianzExtractor,
    IciciLombardExtractor,
    HdfcErgoExtractor,
    MediassistExtractor,
    ParamountExtractor,
    {
      provide: PAYER_EXTRACTORS,
      useFactory: (
        star: StarHealthExtractor,
        bajaj: BajajAllianzExtractor,
        icici: IciciLombardExtractor,
        hdfc: HdfcErgoExtractor,
        medi: MediassistExtractor,
        paramount: ParamountExtractor,
      ) => [star, bajaj, icici, hdfc, medi, paramount] as const,
      inject: [
        StarHealthExtractor,
        BajajAllianzExtractor,
        IciciLombardExtractor,
        HdfcErgoExtractor,
        MediassistExtractor,
        ParamountExtractor,
      ],
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
