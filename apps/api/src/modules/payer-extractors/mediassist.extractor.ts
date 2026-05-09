// Slice CE — Mediassist (Medi Assist) TPA EOB extractor.
//
// Detection signals (any one):
//   - claimRefNum begins with 'MA-', 'MAS/', or 'MEDI' (Mediassist's
//     three observed claim-ref formats).
//   - 'Mediassist' or 'Medi Assist' appears in header / reason copy.
//
// Mediassist is a TPA (third-party administrator), not an insurer
// itself — it adjudicates on behalf of multiple underlying payers.
// EOB phrasing tends to mirror the underlying insurer's, but with
// distinctive Mediassist headers ("Medi Assist Claims Update", "MAS
// Claim Reference"). Mediassist's denial copy is usually verbose
// and maps cleanly to the canonical taxonomy.

import { Injectable } from '@nestjs/common';

import {
  DEDUCTION_CATEGORIES,
  PAYER_CODES,
  type PayerExtractor,
} from './payer-extractor.interface';
import { type ExtractedDeduction, type ExtractedEob } from '../eob-ocr/eob-ocr-adapter.interface';

const MEDIASSIST_REF_RX = /^(MA-|MAS\/|MEDI)/i;
const MEDIASSIST_NAME_RX = /\bmedi[\s-]?assist\b/i;

const MEDIASSIST_CATEGORY_MAP: ReadonlyArray<{ rx: RegExp; canonical: string }> = [
  { rx: /\bcap\s*exceeded\b|\bcapping\b/i, canonical: DEDUCTION_CATEGORIES.CAP_EXCEEDED },
  { rx: /\bco[- ]?pay(ment)?\b/i, canonical: DEDUCTION_CATEGORIES.COPAY },
  { rx: /\bsub[- ]?limit\b|\bproportionate\s*deduction\b/i, canonical: DEDUCTION_CATEGORIES.SUBLIMIT },
  { rx: /\bpre[- ]?existing\b|\bped\b/i, canonical: DEDUCTION_CATEGORIES.PRE_EXISTING },
  {
    rx: /\bexclusion(s)?\b|\bexcluded\b|\bnot\s*covered\b/i,
    canonical: DEDUCTION_CATEGORIES.EXCLUSION,
  },
  {
    // Mediassist-specific phrasing "consumables and disposables"
    // covers gloves / syringes / cotton — non-payable items.
    rx: /\bconsumables?\s*(and|&)\s*disposables?\b|\bnon[- ]?payable\b/i,
    canonical: DEDUCTION_CATEGORIES.NON_PAYABLE_ITEMS,
  },
  { rx: /\bnon[- ]?admissible\b/i, canonical: DEDUCTION_CATEGORIES.NON_ADMISSIBLE },
  {
    rx: /\b(missing|insufficient|incomplete|pending)\s*(supporting\s+)?document(s|ation)?\b/i,
    canonical: DEDUCTION_CATEGORIES.MISSING_DOCUMENTS,
  },
];

@Injectable()
export class MediassistExtractor implements PayerExtractor {
  readonly code = PAYER_CODES.MEDIASSIST;

  detect(eob: ExtractedEob): boolean {
    if (eob.claimRefNum && MEDIASSIST_REF_RX.test(eob.claimRefNum)) return true;
    return MEDIASSIST_NAME_RX.test(collectStrings(eob));
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
  for (const { rx, canonical } of MEDIASSIST_CATEGORY_MAP) {
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
