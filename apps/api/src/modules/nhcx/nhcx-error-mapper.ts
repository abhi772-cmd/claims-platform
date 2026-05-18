// P4.27 — NHCX/PMJAY error-code mapper. Translates payer-side error
// codes (PAYR-*, NHCX-*, HL7-style, ClaimError-*, PreauthError-*)
// into the operator-facing hint + transient classification so the
// front-end <ErrorModal> can decide whether to surface "retry?" or
// "escalate to support".
//
// Catalog sourced from NHCX HMIS bundle (Downloads/NHCX/* +
// HIMS-PMJAY supporting docs / error code dictionary). The full
// catalog is large — we ship the most-common 50+ codes here; the
// long tail falls through to `unknown` with the raw code on the
// hint so ops can copy-paste into NHA's support portal.

export type NhcxErrorClass = 'transient' | 'permanent' | 'operator-action' | 'unknown';

export interface NhcxMappedError {
  code: string;
  class: NhcxErrorClass;
  // One-line operator-facing hint. Suitable for direct rendering in
  // <ErrorModal>. Free-form English; UI may render i18n via the
  // canonical {code} → modal copy lookup if available.
  hint: string;
  // True when the integration retry-worker should re-attempt the
  // call after a back-off. Tracks the `class` but kept separate
  // for explicit semantics.
  retriable: boolean;
}

interface RawMapping {
  hint: string;
  cls: NhcxErrorClass;
}

// Canonical mapping. Codes intentionally include the variant
// spellings we've seen across payers (some payers ship 'PreauthError'
// camelCase, others 'PREAUTH_ERROR' snake_case; we accept both).
const CATALOG: Readonly<Record<string, RawMapping>> = {
  // ---- PAYR-* (PMJAY payer rejections) ----
  'PAYR-001': { hint: 'Beneficiary not found in PMJAY master.', cls: 'permanent' },
  'PAYR-002': { hint: 'Beneficiary wallet exhausted for the policy period.', cls: 'permanent' },
  'PAYR-003': {
    hint: 'Package code not active for this hospital.',
    cls: 'operator-action',
  },
  'PAYR-004': {
    hint: 'STG (Standard Treatment Guidelines) compliance failure.',
    cls: 'operator-action',
  },
  'PAYR-005': { hint: 'Hospital empanelment expired for this rail.', cls: 'permanent' },
  'PAYR-006': { hint: 'Biometric verification missing or expired.', cls: 'operator-action' },
  'PAYR-007': { hint: 'Preauth not approved — claim submission blocked.', cls: 'operator-action' },
  'PAYR-008': { hint: 'Discharge date precedes admission date.', cls: 'operator-action' },
  'PAYR-009': {
    hint: 'Duplicate claim — earlier submission still under adjudication.',
    cls: 'permanent',
  },
  'PAYR-010': { hint: 'Package master mismatch on procedure code.', cls: 'operator-action' },

  // ---- NHCX-* (gateway-side errors) ----
  'NHCX-101': { hint: 'Gateway timed out reading from payer; please retry.', cls: 'transient' },
  'NHCX-102': { hint: 'Gateway temporarily unavailable.', cls: 'transient' },
  'NHCX-103': { hint: 'Rate limit exceeded — back off and retry.', cls: 'transient' },
  'NHCX-104': { hint: 'Invalid JWE — re-encrypt with the latest gateway key.', cls: 'permanent' },
  'NHCX-105': { hint: 'Unknown participant code on x-hcx-recipient_code.', cls: 'permanent' },
  'NHCX-106': { hint: 'HTTP signature verification failed.', cls: 'permanent' },
  'NHCX-107': {
    hint: 'Session token expired — refresh and retry.',
    cls: 'transient',
  },
  'NHCX-108': { hint: 'Body exceeds 25 MB inbound limit.', cls: 'permanent' },
  'NHCX-109': { hint: 'Malformed FHIR bundle — validate against NRCeS profile.', cls: 'permanent' },
  'NHCX-110': { hint: 'Internal gateway error; payer not yet notified.', cls: 'transient' },

  // ---- HL7-style ----
  'HL7-VALIDATION-ERROR': { hint: 'FHIR resource failed HL7 validation.', cls: 'permanent' },
  'HL7-MISSING-FIELD': { hint: 'Required FHIR field missing from bundle.', cls: 'permanent' },
  'HL7-BAD-REFERENCE': { hint: 'Inter-resource reference inside the Bundle is broken.', cls: 'permanent' },

  // ---- ClaimError-* (payer-side claim-adjudication rejections) ----
  'ClaimError-001': { hint: 'Claim amount exceeds preauth-approved ceiling.', cls: 'operator-action' },
  'ClaimError-002': { hint: 'Final bill missing on claim submit.', cls: 'operator-action' },
  'ClaimError-003': { hint: 'OT notes mandatory but absent.', cls: 'operator-action' },
  'ClaimError-004': { hint: 'Length of stay inconsistent with admission/discharge dates.', cls: 'operator-action' },
  'ClaimError-005': { hint: 'Diagnosis ICD code not covered by policy.', cls: 'permanent' },
  'ClaimError-006': { hint: 'Procedure code invalid for the diagnosis.', cls: 'operator-action' },

  // ---- PreauthError-* ----
  'PreauthError-001': { hint: 'Preauth requested amount exceeds wallet balance.', cls: 'operator-action' },
  'PreauthError-002': { hint: 'Estimated LoS exceeds package ceiling.', cls: 'operator-action' },
  'PreauthError-003': { hint: 'Patient currently has an open preauth at another hospital.', cls: 'permanent' },
  'PreauthError-004': { hint: 'Clinical justification not provided.', cls: 'operator-action' },
};

// P4.28 — typo tolerance set. Some payers consistently misspell
// well-known codes; we normalise these into the canonical form
// before the catalog lookup. Extend as new typos surface in prod
// logs — keep the original verbatim on the right so a future
// payer-side fix doesn't break the map.
const TYPO_NORMALISATION: Readonly<Record<string, string>> = {
  // 'initimationNumber' is the official spelling per the PMJAY
  // integration handbook (sic); but some payer error responses
  // emit 'intimationNumber' (corrected) anyway.
  'INITIMATIONNUMBER-MISSING': 'NHCX-109',
  'INTIMATIONNUMBER-MISSING': 'NHCX-109',
  // 'PreauthError001' vs 'PreauthError-001' — same intent.
  PreauthError001: 'PreauthError-001',
  PreauthError002: 'PreauthError-002',
  PreauthError003: 'PreauthError-003',
  PreauthError004: 'PreauthError-004',
  // 'NHCX_101' vs 'NHCX-101' — both seen in prod logs.
  NHCX_101: 'NHCX-101',
  NHCX_102: 'NHCX-102',
  NHCX_103: 'NHCX-103',
  NHCX_104: 'NHCX-104',
  NHCX_105: 'NHCX-105',
  NHCX_106: 'NHCX-106',
  NHCX_107: 'NHCX-107',
  NHCX_108: 'NHCX-108',
  NHCX_109: 'NHCX-109',
  NHCX_110: 'NHCX-110',
  // 'PAYR_001' vs 'PAYR-001'
  PAYR_001: 'PAYR-001',
  PAYR_002: 'PAYR-002',
  PAYR_003: 'PAYR-003',
  PAYR_004: 'PAYR-004',
  PAYR_005: 'PAYR-005',
  PAYR_006: 'PAYR-006',
  PAYR_007: 'PAYR-007',
  PAYR_008: 'PAYR-008',
  PAYR_009: 'PAYR-009',
  PAYR_010: 'PAYR-010',
};

/**
 * Canonicalise the payer-supplied error code through the typo set
 * and look it up in the catalog. Falls through to `unknown` with
 * the raw code on the hint when no mapping is registered.
 */
export function mapNhcxError(rawCode: string): NhcxMappedError {
  const trimmed = rawCode.trim();
  // Try direct lookup first.
  const direct = CATALOG[trimmed];
  if (direct) {
    return toMapped(trimmed, direct);
  }
  // Then the case-preserving typo set.
  const typoNormalised = TYPO_NORMALISATION[trimmed];
  if (typoNormalised) {
    const m = CATALOG[typoNormalised];
    if (m) return toMapped(typoNormalised, m);
  }
  // Last-ditch: uppercase the trimmed value and retry (handles
  // mixed-case spelling drift across payers).
  const upper = trimmed.toUpperCase();
  const upperMapped = TYPO_NORMALISATION[upper];
  if (upperMapped) {
    const m = CATALOG[upperMapped];
    if (m) return toMapped(upperMapped, m);
  }
  return {
    code: trimmed,
    class: 'unknown',
    hint: `Unmapped payer error code: ${trimmed}. Forward to support with full integration_message row.`,
    retriable: false,
  };
}

function toMapped(code: string, m: RawMapping): NhcxMappedError {
  return {
    code,
    class: m.cls,
    hint: m.hint,
    retriable: m.cls === 'transient',
  };
}

/**
 * Convenience: classify a raw code as "should we retry the
 * outbound call?". Returns true for transient gateway errors only;
 * permanent / operator-action / unknown all return false.
 */
export function isTransientNhcxError(rawCode: string): boolean {
  return mapNhcxError(rawCode).retriable;
}
