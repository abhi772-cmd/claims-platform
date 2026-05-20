import { Injectable } from '@nestjs/common';

import {
  type CardExtractInput,
  type CardExtractResult,
  type CardOcrAdapter,
} from './card-ocr-adapter.interface';

// Bound when CARD_OCR_MODE='off' (the default). Returns 'skipped' for
// every request — operators type card details into the intake form by
// hand until the OCR machine is wired up.
@Injectable()
export class DisabledCardOcrAdapter implements CardOcrAdapter {
  async extractCard(_input: CardExtractInput): Promise<CardExtractResult> {
    return { status: 'skipped', engine: 'disabled' };
  }
}
