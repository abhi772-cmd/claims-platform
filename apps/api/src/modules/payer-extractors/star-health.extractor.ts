// Slice CA — Star Health Insurance Co. EOB extractor.
//
// Detection signals (any one is enough):
//   - claimRefNum begins with 'STAR/' (Star's standard claim ref
//     format observed in our reference EOBs).
//   - Any deduction.reason / shortPaymentReasons string mentions
//     'Star Health' (header text often surfaces in OCR output).
//
// Normalisation maps Star's deduction copy to our canonical taxonomy.
// The mapping is best-effort — anything we don't recognise lands
// 'unknown' so the settlement UI surfaces it for review.

import { Injectable } from '@nestjs/common';

import {
  DEDUCTION_CATEGORIES,
  PAYER_CODES,
  type PayerExtractor,
} from './payer-extractor.interface';
import { type ExtractedDeduction, type ExtractedEob } from '../eob-ocr/eob-ocr-adapter.interface';

const STAR_REF_PREFIX = 'STAR/';
const STAR_NAME_RX = /\bstar\s*health\b/i;

const STAR_CATEGORY_MAP: ReadonlyArray<{ rx: RegExp; canonical: string }> = [
  { rx: /\bcap\s*exceeded\b/i, canonical: DEDUCTION_CATEGORIES.CAP_EXCEEDED },
  { rx: /\bco[- ]?pay\b/i, canonical: DEDUCTION_CATEGORIES.COPAY },
  { rx: /\bsub[- ]?limit\b/i, canonical: DEDUCTION_CATEGORIES.SUBLIMIT },
  { rx: /\bpre[- ]?existing\b/i, canonical: DEDUCTION_CATEGORIES.PRE_EXISTING },
  { rx: /\bexclusion(s)?\b|\bexcluded\b/i, canonical: DEDUCTION_CATEGORIES.EXCLUSION },
  { rx: /\bnon[- ]?payable\b/i, canonical: DEDUCTION_CATEGORIES.NON_PAYABLE_ITEMS },
  { rx: /\bnon[- ]?admissible\b/i, canonical: DEDUCTION_CATEGORIES.NON_ADMISSIBLE },
  { rx: /\b(missing|insufficient)\s+document(s)?\b/i, canonical: DEDUCTION_CATEGORIES.MISSING_DOCUMENTS },
];

@Injectable()
export class StarHealthExtractor implements PayerExtractor {
  readonly code = PAYER_CODES.STAR_HEALTH;

  detect(eob: ExtractedEob): boolean {
    if (eob.claimRefNum && eob.claimRefNum.toUpperCase().startsWith(STAR_REF_PREFIX)) {
      return true;
    }
    const haystack = collectStrings(eob);
    return STAR_NAME_RX.test(haystack);
  }

  normalise(eob: ExtractedEob): ExtractedEob {
    return {
      ...eob,
      deductions: eob.deductions.map(normaliseDeduction),
    };
  }
}

function normaliseDeduction(d: ExtractedDeduction): ExtractedDeduction {
  const canonical = mapCategory(d.category) ?? mapCategory(d.reason ?? '');
  if (!canonical) {
    return { ...d, category: DEDUCTION_CATEGORIES.UNKNOWN };
  }
  return { ...d, category: canonical };
}

function mapCategory(text: string): string | null {
  for (const { rx, canonical } of STAR_CATEGORY_MAP) {
    if (rx.test(text)) return canonical;
  }
  return null;
}

function collectStrings(eob: ExtractedEob): string {
  return [
    ...eob.shortPaymentReasons,
    ...eob.deductions.map((d) => `${d.category} ${d.reason ?? ''}`),
  ].join(' ');
}
