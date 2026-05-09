// Slice CE — Paramount Health Services TPA EOB extractor.
//
// Detection signals (any one):
//   - claimRefNum begins with 'PHS', 'PHI', or 'PMT-' (the three
//     observed claim-ref formats).
//   - 'Paramount Health' or 'Paramount Health Services' appears
//     in header / reason copy.
//
// Like Mediassist, Paramount is a TPA — it adjudicates on behalf
// of multiple insurers. Distinctive Paramount phrasing includes
// "investigation in progress" (which we map to missing_documents
// since the claim is held pending more info), and "co-share"
// for co-payment.

import { Injectable } from '@nestjs/common';

import {
  DEDUCTION_CATEGORIES,
  PAYER_CODES,
  type PayerExtractor,
} from './payer-extractor.interface';
import { type ExtractedDeduction, type ExtractedEob } from '../eob-ocr/eob-ocr-adapter.interface';

const PARAMOUNT_REF_RX = /^(PHS|PHI|PMT-)/i;
const PARAMOUNT_NAME_RX = /\bparamount\s*health\b/i;

const PARAMOUNT_CATEGORY_MAP: ReadonlyArray<{ rx: RegExp; canonical: string }> = [
  { rx: /\bcap\s*exceeded\b|\bcapping\b/i, canonical: DEDUCTION_CATEGORIES.CAP_EXCEEDED },
  {
    rx: /\bco[- ]?(pay(ment)?|share)\b/i,
    canonical: DEDUCTION_CATEGORIES.COPAY,
  },
  { rx: /\bsub[- ]?limit\b|\binner\s*limit\b/i, canonical: DEDUCTION_CATEGORIES.SUBLIMIT },
  { rx: /\bpre[- ]?existing\b|\bped\b/i, canonical: DEDUCTION_CATEGORIES.PRE_EXISTING },
  {
    rx: /\bexclusion(s)?\b|\bexcluded\b|\bnot\s*covered\b/i,
    canonical: DEDUCTION_CATEGORIES.EXCLUSION,
  },
  { rx: /\bnon[- ]?payable\b/i, canonical: DEDUCTION_CATEGORIES.NON_PAYABLE_ITEMS },
  { rx: /\bnon[- ]?admissible\b/i, canonical: DEDUCTION_CATEGORIES.NON_ADMISSIBLE },
  {
    // "Investigation in progress" is Paramount's hold-pending-
    // documents copy. We map to missing_documents because that's
    // operationally the same: ops needs to provide more info
    // before the claim can be adjudicated.
    rx:
      /\binvestigation\s*in\s*progress\b|\b(missing|insufficient|incomplete|pending)\s*(supporting\s+)?document(s|ation)?\b/i,
    canonical: DEDUCTION_CATEGORIES.MISSING_DOCUMENTS,
  },
];

@Injectable()
export class ParamountExtractor implements PayerExtractor {
  readonly code = PAYER_CODES.PARAMOUNT;

  detect(eob: ExtractedEob): boolean {
    if (eob.claimRefNum && PARAMOUNT_REF_RX.test(eob.claimRefNum)) return true;
    return PARAMOUNT_NAME_RX.test(collectStrings(eob));
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
  for (const { rx, canonical } of PARAMOUNT_CATEGORY_MAP) {
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
