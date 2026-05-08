// Slice BM — whitelist of FHIR `system` URIs we expect to see on
// inbound NHCX bundles. Purpose: operational visibility. The validator
// walks every Bundle entry's coding[]/identifier[] entries and
// classifies the unique systems against these sets so unknowns
// surface in logs (and, eventually, ops alerts). We don't reject on
// unknowns in v1 — the gateway evolves faster than our whitelist
// could, and a hard reject would hold up legitimate callbacks.
//
// Three buckets:
//   1. UNIVERSAL  — terminology shared across rails. Always allowed.
//   2. NHCX       — private-rail (HCX 0.7.1) and platform-internal.
//                   Always allowed.
//   3. PMJAY      — only meaningful for PMJAY-mode tenants. We flag
//                   PMJAY systems on non-PMJAY tenants for ops to
//                   investigate (likely a misrouted callback).

// HL7 + FHIR R4 base systems (terminology.hl7.org / hl7.org).
export const UNIVERSAL_SYSTEMS: ReadonlySet<string> = new Set([
  'http://terminology.hl7.org/CodeSystem/v2-0203',
  'http://terminology.hl7.org/CodeSystem/processpriority',
  'http://terminology.hl7.org/CodeSystem/organization-type',
  'http://terminology.hl7.org/CodeSystem/claim-type',
  'http://hl7.org/fhir/sid/icd-10',
  'http://hl7.org/fhir/identifier-use',
  'https://hl7.org/fhir/R4/v2/0360/2.7/index.html',
]);

// Standard NHCX (HCX 0.7.1) + ABDM + DigiSparsh-internal systems.
export const NHCX_SYSTEMS: ReadonlySet<string> = new Set([
  // ABDM / NDHM core registries.
  'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-organization',
  'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-identifier-type-code',
  'https://healthid.abdm.gov.in',
  'https://facility.abdm.gov.in',
  'https://hpr.abdm.gov.in',
  // Platform-internal identifiers used in our outbound bundles.
  'urn:digisparsh:hospital:mrn',
  'urn:digisparsh:claim:id',
  'urn:digisparsh:claim:payerRefNum',
  'urn:digisparsh:procedure:code',
]);

// PMJAY-specific systems. Documented in
// `HIMS-PMJAY suppporting docs/FHIR_bundles_PMJAY_ext/`.
export const PMJAY_SYSTEMS: ReadonlySet<string> = new Set([
  // PMJAY package master + diagnosis codes (a single system for both
  // — PMJAY publishes them together under payer.pmjay.nha.gov.in).
  'https://payer.pmjay.nha.gov.in',
  // PMJAY task-operation + task-reason code systems (Slices BH/BI).
  'https://payer.pmjay.nha.gov.in/CodeSystem/task-operation',
  'https://payer.pmjay.nha.gov.in/CodeSystem/task-reason',
  // PMJAY HCX endpoint identifiers (used as Bundle.identifier.system
  // and as CoverageEligibilityRequest.identifier.system on PMJAY
  // bundles).
  'https://hcx.pmjay.gov.in/v1/coverageeligibility/check',
  'https://hcx.pmjay.gov.in/v1/preauthorization',
  'https://hcx.pmjay.gov.in/v1/claim',
  // PMJAY beneficiary + provider registries.
  'https://bis.pmjay.gov.in',
  'https://provider.pmjay.gov.in',
  'https://payer.nha.gov.in',
  'https://nhcx.pmjay.gov.in',
]);

// Identifier-type codes we expect to see under the
// `ndhm-identifier-type-code` system. PMJAY is the headline addition
// for this slice; the rest are the common FHIR R4 terminology codes
// that ride alongside (HPID, HPIN, etc.).
export const KNOWN_NDHM_IDENTIFIER_TYPE_CODES: ReadonlySet<string> = new Set([
  'PMJAY',
  'HPID',
  'HPIN',
  'JHN',
  'PI',
  'NPI',
  'NIIP',
  'NH',
]);

export const NDHM_IDENTIFIER_TYPE_SYSTEM =
  'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-identifier-type-code';
