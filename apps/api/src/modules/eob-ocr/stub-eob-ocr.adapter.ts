import { Injectable } from '@nestjs/common';

import {
  type EobOcrAdapter,
  type ExtractInput,
  type ExtractResult,
  type ExtractedEob,
} from './eob-ocr-adapter.interface';

// Bound when EOB_OCR_MODE='stub'. Deterministic fixtures matched
// against sentinel strings the test fixtures embed in the document
// buffer. Lets integration tests drive the "auto-extracted fields
// show up on the settlement form" UX without an OCR engine running.
//
// Three sentinel patterns:
//   * `STUB-EOB-CLEAN-<refnum>-<amount>` → fully-paid extraction
//   * `STUB-EOB-SHORT-<refnum>-<received>-<expected>` → short-paid
//     with a single deduction line
//   * `STUB-EOB-FAIL` → status='failed' (so tests cover the failure
//     path without needing an actual broken PDF)
//
// Anything else → status='low_confidence' with empty fields, which
// matches what the eventual real adapter does when the model can't
// find recognisable structure.

const PREFIX_CLEAN = 'STUB-EOB-CLEAN-';
const PREFIX_SHORT = 'STUB-EOB-SHORT-';
const SENTINEL_FAIL = 'STUB-EOB-FAIL';

@Injectable()
export class StubEobOcrAdapter implements EobOcrAdapter {
  async extract(input: ExtractInput): Promise<ExtractResult> {
    if (!input.buffer) {
      // The real adapter will pull from S3 via StorageAdapter.getObject
      // when only (bucket, key) is supplied (Slice AS pattern). The
      // stub only knows what's in memory — return skipped so callers
      // don't mistake "we didn't try" for "we couldn't find anything".
      return { status: 'skipped', engine: 'stub' };
    }
    const text = input.buffer.toString('utf8');

    if (text.includes(SENTINEL_FAIL)) {
      return {
        status: 'failed',
        engine: 'stub',
        error: 'Stub-injected failure for testing',
      };
    }

    const cleanMatch = new RegExp(
      `${PREFIX_CLEAN}([A-Za-z0-9-]+)-(\\d+)`,
    ).exec(text);
    if (cleanMatch) {
      const fields: ExtractedEob = {
        claimRefNum: cleanMatch[1],
        receivedAmount: Number(cleanMatch[2]),
        deductionAmount: 0,
        deductions: [],
        shortPaymentReasons: [],
        confidence: {
          claimRefNum: 1,
          receivedAmount: 1,
          deductionAmount: 1,
        },
      };
      return { status: 'extracted', engine: 'stub', fields };
    }

    const shortMatch = new RegExp(
      `${PREFIX_SHORT}([A-Za-z0-9-]+)-(\\d+)-(\\d+)`,
    ).exec(text);
    if (shortMatch) {
      const received = Number(shortMatch[2]);
      const expected = Number(shortMatch[3]);
      const deductionAmount = Math.max(0, expected - received);
      const fields: ExtractedEob = {
        claimRefNum: shortMatch[1],
        receivedAmount: received,
        deductionAmount,
        deductions: [
          {
            category: 'cap_exceeded',
            amount: deductionAmount,
            reason: 'Cap exceeded under rider B',
          },
        ],
        shortPaymentReasons: ['Cap exceeded under rider B'],
        confidence: {
          claimRefNum: 1,
          receivedAmount: 1,
          deductionAmount: 1,
        },
      };
      return { status: 'extracted', engine: 'stub', fields };
    }

    return {
      status: 'low_confidence',
      engine: 'stub',
      fields: {
        deductions: [],
        shortPaymentReasons: [],
      },
    };
  }
}

// Exported for tests + fixture authors so the sentinel format stays
// in lockstep across the codebase.
export const STUB_EOB_SENTINELS = {
  clean: (refNum: string, amount: number): string =>
    `${PREFIX_CLEAN}${refNum}-${amount}`,
  short: (refNum: string, received: number, expected: number): string =>
    `${PREFIX_SHORT}${refNum}-${received}-${expected}`,
  fail: SENTINEL_FAIL,
};
