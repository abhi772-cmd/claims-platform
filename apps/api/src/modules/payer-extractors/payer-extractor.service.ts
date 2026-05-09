// Slice CA — registry + dispatch service for per-payer extractors.
//
// detectAndNormalise() iterates the registry, picks the first
// extractor whose detect(eob) returns true, runs its normalise(eob),
// and tags the result with payerCode. When no extractor matches,
// the eob falls through unchanged with payerCode='generic' — the
// settlement UI surfaces this as "payer not auto-detected; please
// select manually".

import { Inject, Injectable } from '@nestjs/common';

import {
  PAYER_CODES,
  PAYER_EXTRACTORS,
  type PayerCode,
  type PayerExtractor,
} from './payer-extractor.interface';
import { type ExtractedEob } from '../eob-ocr/eob-ocr-adapter.interface';

export interface DetectAndNormaliseResult {
  payerCode: PayerCode;
  eob: ExtractedEob;
}

@Injectable()
export class PayerExtractorService {
  constructor(
    @Inject(PAYER_EXTRACTORS) private readonly extractors: readonly PayerExtractor[],
  ) {}

  detectAndNormalise(eob: ExtractedEob): DetectAndNormaliseResult {
    for (const x of this.extractors) {
      if (x.detect(eob)) {
        return { payerCode: x.code, eob: x.normalise(eob) };
      }
    }
    return { payerCode: PAYER_CODES.GENERIC, eob };
  }
}
