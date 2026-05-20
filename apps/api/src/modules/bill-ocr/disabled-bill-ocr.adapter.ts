import { Injectable } from '@nestjs/common';

import {
  type BillExtractInput,
  type BillExtractResult,
  type BillOcrAdapter,
} from './bill-ocr-adapter.interface';

// Bound when BILL_OCR_MODE='off' (the default). Returns 'skipped' for
// every request — operators paste the bill into the classifier by hand
// until the OCR machine is wired up.
@Injectable()
export class DisabledBillOcrAdapter implements BillOcrAdapter {
  async extractBill(_input: BillExtractInput): Promise<BillExtractResult> {
    return { status: 'skipped', engine: 'disabled', lines: [] };
  }
}
