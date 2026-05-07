import { Injectable } from '@nestjs/common';

import {
  type EobOcrAdapter,
  type ExtractInput,
  type ExtractResult,
} from './eob-ocr-adapter.interface';

// Bound when EOB_OCR_MODE='off' (the default). Returns 'skipped' for
// every request — operators key in EOB fields by hand on the
// settlement screen until the OSS path lands.
@Injectable()
export class DisabledEobOcrAdapter implements EobOcrAdapter {
  async extract(_input: ExtractInput): Promise<ExtractResult> {
    return { status: 'skipped', engine: 'disabled' };
  }
}
