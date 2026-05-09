// Slice CE — HDFC Ergo General Insurance EOB extractor.
//
// Detection signals (any one):
//   - claimRefNum begins with 'HE/', 'HDFC/', or 'HEHI' (HDFC
//     Ergo Health Insurance prefix on some retail policies).
//   - 'HDFC Ergo' or 'HDFC ERGO' appears in header / reason copy.
//
// HDFC Ergo's EOB phrasing is closer to Bajaj's than ICICI's —
// they use "deductible", "co-payment", and a distinctive
// "Reasonable & Customary" exclusion copy on aesthetic procedures.

import { Injectable } from '@nestjs/common';

import {
  DEDUCTION_CATEGORIES,
  PAYER_CODES,
  type PayerExtractor,
} from './payer-extractor.interface';
import { type ExtractedDeduction, type ExtractedEob } from '../eob-ocr/eob-ocr-adapter.interface';

const HDFC_REF_RX = /^(HE\/|HDFC\/|HEHI)/i;
const HDFC_NAME_RX = /\bhdfc\s*ergo\b/i;

const HDFC_CATEGORY_MAP: ReadonlyArray<{ rx: RegExp; canonical: string }> = [
  { rx: /\bcap\s*exceeded\b|\bcapping\b/i, canonical: DEDUCTION_CATEGORIES.CAP_EXCEEDED },
  {
    rx: /\bco[- ]?pay(ment)?\b|\bdeductible\b/i,
    canonical: DEDUCTION_CATEGORIES.COPAY,
  },
  { rx: /\bsub[- ]?limit\b|\binner\s*limit\b/i, canonical: DEDUCTION_CATEGORIES.SUBLIMIT },
  { rx: /\bpre[- ]?existing\b|\bped\b/i, canonical: DEDUCTION_CATEGORIES.PRE_EXISTING },
  {
    // "Reasonable & Customary" is HDFC's signature phrase for
    // payer-judged-excessive amounts; treat as exclusion.
    rx: /\breasonable\s*(&|and)\s*customary\b|\bexclusion(s)?\b|\bexcluded\b/i,
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
export class HdfcErgoExtractor implements PayerExtractor {
  readonly code = PAYER_CODES.HDFC_ERGO;

  detect(eob: ExtractedEob): boolean {
    if (eob.claimRefNum && HDFC_REF_RX.test(eob.claimRefNum)) return true;
    return HDFC_NAME_RX.test(collectStrings(eob));
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
  for (const { rx, canonical } of HDFC_CATEGORY_MAP) {
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
