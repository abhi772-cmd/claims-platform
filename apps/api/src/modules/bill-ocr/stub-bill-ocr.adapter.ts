import { Injectable } from '@nestjs/common';

import {
  type BillExtractInput,
  type BillExtractResult,
  type BillOcrAdapter,
  type BillOcrLine,
} from './bill-ocr-adapter.interface';

// Bound when BILL_OCR_MODE='stub'. Deterministic fixtures matched
// against sentinel strings the test fixtures embed in the buffer. Lets
// tests drive the "upload bill → classified lines appear" UX without an
// OCR engine running.
//
//   * `STUB-BILL-CLEAN` → a fixed multi-row bill (mix of medical +
//     non-medical so the downstream classifier has something to strip)
//   * `STUB-BILL-FAIL`  → status='failed'
//
// Anything else → status='low_confidence' with no lines, matching what
// the real adapter returns when the model can't read the bill.

const SENTINEL_CLEAN = 'STUB-BILL-CLEAN';
const SENTINEL_FAIL = 'STUB-BILL-FAIL';

// Amounts in paise. Includes non-medical rows (toiletry kit, attendant
// food, TV rental) so the classifier exercises its strip logic.
const STUB_LINES: BillOcrLine[] = [
  { description: 'Room rent - single AC', amountPaise: 800000 },
  { description: 'Surgery', amountPaise: 4500000 },
  { description: 'Toiletry kit', amountPaise: 30000 },
  { description: 'Attendant food', amountPaise: 90000 },
  { description: 'TV rental', amountPaise: 15000 },
];

@Injectable()
export class StubBillOcrAdapter implements BillOcrAdapter {
  async extractBill(input: BillExtractInput): Promise<BillExtractResult> {
    const text = input.buffer.toString('utf8');

    if (text.includes(SENTINEL_FAIL)) {
      return {
        status: 'failed',
        engine: 'stub',
        lines: [],
        error: 'Stub-injected failure for testing',
      };
    }
    if (text.includes(SENTINEL_CLEAN)) {
      return { status: 'extracted', engine: 'stub', lines: [...STUB_LINES] };
    }
    return { status: 'low_confidence', engine: 'stub', lines: [] };
  }
}

// Exported so tests + fixture authors keep the sentinel format in
// lockstep across the codebase.
export const STUB_BILL_SENTINELS = {
  clean: SENTINEL_CLEAN,
  fail: SENTINEL_FAIL,
};
