// Slice CA — Bajaj Allianz General Insurance EOB extractor.
//
// Detection signals (any one is enough):
//   - claimRefNum begins with 'BAGI' or 'BAJAJ' (Bajaj's two
//     observed claim-reference formats).
//   - Any header text mentions 'Bajaj Allianz'.
//
// Normalisation map mirrors Star's, with Bajaj-specific copy added:
// "Excluded items" maps to 'exclusion', "Non-payable" to
// 'non_payable_items', "Insufficient documents" to
// 'missing_documents', etc.

import { Injectable } from '@nestjs/common';

import {
  DEDUCTION_CATEGORIES,
  PAYER_CODES,
  type PayerExtractor,
} from './payer-extractor.interface';
import { type ExtractedDeduction, type ExtractedEob } from '../eob-ocr/eob-ocr-adapter.interface';

const BAJAJ_REF_RX = /^(BAGI|BAJAJ)/i;
const BAJAJ_NAME_RX = /\bbajaj\s*allianz\b/i;

const BAJAJ_CATEGORY_MAP: ReadonlyArray<{ rx: RegExp; canonical: string }> = [
  { rx: /\bcap\s*exceeded\b|\bcapping\b/i, canonical: DEDUCTION_CATEGORIES.CAP_EXCEEDED },
  { rx: /\bco[- ]?pay(ment)?\b/i, canonical: DEDUCTION_CATEGORIES.COPAY },
  { rx: /\bsub[- ]?limit\b|\binner\s*limit\b/i, canonical: DEDUCTION_CATEGORIES.SUBLIMIT },
  { rx: /\bpre[- ]?existing\b|\bped\b/i, canonical: DEDUCTION_CATEGORIES.PRE_EXISTING },
  { rx: /\bexcluded\s*items?\b|\bexclusion(s)?\b/i, canonical: DEDUCTION_CATEGORIES.EXCLUSION },
  { rx: /\bnon[- ]?payable\b/i, canonical: DEDUCTION_CATEGORIES.NON_PAYABLE_ITEMS },
  { rx: /\bnon[- ]?admissible\b/i, canonical: DEDUCTION_CATEGORIES.NON_ADMISSIBLE },
  {
    rx: /\b(insufficient|missing|incomplete)\s*(supporting\s+)?document(s|ation)?\b/i,
    canonical: DEDUCTION_CATEGORIES.MISSING_DOCUMENTS,
  },
];

@Injectable()
export class BajajAllianzExtractor implements PayerExtractor {
  readonly code = PAYER_CODES.BAJAJ_ALLIANZ;

  detect(eob: ExtractedEob): boolean {
    if (eob.claimRefNum && BAJAJ_REF_RX.test(eob.claimRefNum)) return true;
    return BAJAJ_NAME_RX.test(collectStrings(eob));
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
  for (const { rx, canonical } of BAJAJ_CATEGORY_MAP) {
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
