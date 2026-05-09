// Slice CA — per-payer EOB extractor framework.
//
// The OCR adapter (Slice AX) produces a generic ExtractedEob with
// free-form deduction categories ("co-pay", "non-payable items",
// "Excluded items"). Settlement reviewers want a canonical taxonomy
// they can write rules against. Per-payer extractors do that mapping
// in a place where payer-specific quirks are isolated and explicit.
//
// Two-stage flow inside DocumentService.extractEob:
//   1. eobOcrAdapter.extract() → raw ExtractedEob
//   2. payerExtractorService.detectAndNormalise(raw) → { payerCode, eob }
//
// New payers land as a new file implementing PayerExtractor + an
// entry in PAYER_EXTRACTORS_REGISTRY. The OCR machine's per-payer
// prompt tuning happens Python-side; this TS surface canonicalises
// downstream of whatever the OCR layer returns.

import { type ExtractedEob } from '../eob-ocr/eob-ocr-adapter.interface';

// Canonical deduction taxonomy. Settlement rules + analytics drill
// against these codes. Adding a new code is a contract change — the
// frontend's denial-modal copy must follow.
export const DEDUCTION_CATEGORIES = {
  CAP_EXCEEDED: 'cap_exceeded',
  COPAY: 'copay',
  EXCLUSION: 'exclusion',
  PRE_EXISTING: 'pre_existing',
  SUBLIMIT: 'sublimit',
  NON_PAYABLE_ITEMS: 'non_payable_items',
  MISSING_DOCUMENTS: 'missing_documents',
  NON_ADMISSIBLE: 'non_admissible',
  // Catch-all for payer phrases we don't yet map. The settlement UI
  // surfaces these so reviewers can flag new patterns for the
  // taxonomy.
  UNKNOWN: 'unknown',
} as const;

export type DeductionCategory =
  (typeof DEDUCTION_CATEGORIES)[keyof typeof DEDUCTION_CATEGORIES];

export const PAYER_CODES = {
  STAR_HEALTH: 'star_health',
  BAJAJ_ALLIANZ: 'bajaj_allianz',
  ICICI_LOMBARD: 'icici_lombard',
  HDFC_ERGO: 'hdfc_ergo',
  MEDIASSIST: 'mediassist',
  PARAMOUNT: 'paramount',
  // Generic = no extractor matched. The eob falls through unchanged.
  GENERIC: 'generic',
} as const;

export type PayerCode = (typeof PAYER_CODES)[keyof typeof PAYER_CODES];

// Extractor contract. detect() runs first across the registry; the
// first true wins (registry order matters — list narrower / more
// distinctive payers first). normalise() takes the matched eob and
// returns a copy with deduction categories canonicalised against
// DEDUCTION_CATEGORIES.
export interface PayerExtractor {
  readonly code: Exclude<PayerCode, 'generic'>;
  detect(eob: ExtractedEob): boolean;
  normalise(eob: ExtractedEob): ExtractedEob;
}

export const PAYER_EXTRACTORS = Symbol('PAYER_EXTRACTORS');
