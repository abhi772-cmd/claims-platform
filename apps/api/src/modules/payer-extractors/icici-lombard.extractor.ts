// Slice CE — ICICI Lombard General Insurance EOB extractor.
//
// Detection signals (any one):
//   - claimRefNum begins with 'ICL', 'ICICI/', or 'ILGI' (the
//     three observed claim-ref formats in our reference EOBs).
//   - 'ICICI Lombard' appears in header / reason copy.
//
// Normalisation maps ICICI's deduction phrasing to the canonical
// taxonomy. ICICI tends toward British-English spellings ("non-
// payable items"), tighter sub-limit copy ("room-rent capping"),
// and explicit "first 24-hour" exclusions for some riders.

import { Injectable } from '@nestjs/common';

import {
  DEDUCTION_CATEGORIES,
  PAYER_CODES,
  type PayerExtractor,
} from './payer-extractor.interface';
import { type ExtractedDeduction, type ExtractedEob } from '../eob-ocr/eob-ocr-adapter.interface';

const ICICI_REF_RX = /^(ICL|ICICI|ILGI)/i;
const ICICI_NAME_RX = /\bicici\s*lombard\b/i;

const ICICI_CATEGORY_MAP: ReadonlyArray<{ rx: RegExp; canonical: string }> = [
  // ICICI uses "capping" frequently for room-rent and ICU
  // sublimits — match those distinctively.
  { rx: /\b(room[-\s]?rent|icu)\s*cap(ping)?\b/i, canonical: DEDUCTION_CATEGORIES.SUBLIMIT },
  { rx: /\bcap\s*exceeded\b|\bcapping\b/i, canonical: DEDUCTION_CATEGORIES.CAP_EXCEEDED },
  { rx: /\bco[- ]?pay(ment)?\b/i, canonical: DEDUCTION_CATEGORIES.COPAY },
  { rx: /\bsub[- ]?limit\b|\binner\s*limit\b/i, canonical: DEDUCTION_CATEGORIES.SUBLIMIT },
  { rx: /\bpre[- ]?existing\b|\bped\b/i, canonical: DEDUCTION_CATEGORIES.PRE_EXISTING },
  {
    rx: /\bexclusion(s)?\b|\bexcluded\b|\bfirst\s*24[- ]?hour\b/i,
    canonical: DEDUCTION_CATEGORIES.EXCLUSION,
  },
  { rx: /\bnon[- ]?payable\b/i, canonical: DEDUCTION_CATEGORIES.NON_PAYABLE_ITEMS },
  { rx: /\bnon[- ]?admissible\b/i, canonical: DEDUCTION_CATEGORIES.NON_ADMISSIBLE },
  {
    rx: /\b(missing|insufficient|incomplete)\s*(supporting\s+)?document(s|ation)?\b/i,
    canonical: DEDUCTION_CATEGORIES.MISSING_DOCUMENTS,
  },
];

@Injectable()
export class IciciLombardExtractor implements PayerExtractor {
  readonly code = PAYER_CODES.ICICI_LOMBARD;

  detect(eob: ExtractedEob): boolean {
    if (eob.claimRefNum && ICICI_REF_RX.test(eob.claimRefNum)) return true;
    return ICICI_NAME_RX.test(collectStrings(eob));
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
  for (const { rx, canonical } of ICICI_CATEGORY_MAP) {
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
