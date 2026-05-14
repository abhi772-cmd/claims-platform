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
  'http://terminology.hl7.org/CodeSystem/claimcareteamrole',
  'http://terminology.hl7.org/CodeSystem/v3-Confidentiality',
  'http://hl7.org/fhir/sid/icd-10',
  'http://hl7.org/fhir/identifier-use',
  // SNOMED CT — required for NRCES NHCX bundles (Claim.type,
  // diagnosis.type, procedure coding).
  'http://snomed.info/sct',
  // LOINC — referenced by the NRCES "Guide for using LOINC in ABDM
  // FHIR Resources" PDF for observation / document codings.
  'http://loinc.org',
  'https://hl7.org/fhir/R4/v2/0360/2.7/index.html',
]);

// Standard NHCX (NRCES ABDM v6.5.0) + DigiSparsh-internal systems.
// Source: every `CodeSystem-ndhm-*.html.md` page under
// `D:\NHCX context\md\nrces.in\ndhm\fhir\r4\`. The previous list
// recognised only 2 of these; an inbound payer bundle that codes
// against any of the others surfaced as "unknown system" in the ops
// validator log even though the system is canonical NHCX.
export const NHCX_SYSTEMS: ReadonlySet<string> = new Set([
  // ABDM / NDHM core registries.
  'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-organization',
  'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-identifier-type-code',
  // Adjudication + claim shape.
  'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-adjudication-reason',
  'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-benefit-type',
  'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-billing-codes',
  'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-claim-exclusion',
  'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-coverage-type',
  'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-form-code',
  'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-insuranceplan-type',
  'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-payment-type',
  'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-plan-type',
  'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-price-components',
  'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-program-code',
  'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-reason-code',
  'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-related-claim-relationship-code',
  // Supporting info + tasks.
  'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-supportinginfo-category',
  'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-supportinginfo-code',
  'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-task-codes',
  'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-task-input-type-code',
  'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-task-output-type',
  'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-task-output-value',
  // ABDM identifier registries.
  'https://healthid.abdm.gov.in',
  'https://facility.abdm.gov.in',
  'https://hpr.abdm.gov.in',
  // Platform-internal identifiers used in our outbound bundles.
  'urn:digisparsh:hospital:mrn',
  'urn:digisparsh:claim:id',
  'urn:digisparsh:claim:payerRefNum',
  'urn:digisparsh:procedure:code',
  'urn:digisparsh:doctor:registration',
  'urn:digisparsh:org',
]);

// NDHM CodeSystem URI base — exported for reuse in builders so the
// list above stays the single source of truth.
export const NDHM_SYSTEM_BASE =
  'https://nrces.in/ndhm/fhir/r4/CodeSystem';

// Named accessors for the most-used NDHM systems. Builders should
// reference these constants instead of inline-stringing the URI.
export const NDHM_SYSTEMS = {
  organization: `${NDHM_SYSTEM_BASE}/ndhm-organization`,
  identifierTypeCode: `${NDHM_SYSTEM_BASE}/ndhm-identifier-type-code`,
  adjudicationReason: `${NDHM_SYSTEM_BASE}/ndhm-adjudication-reason`,
  benefitType: `${NDHM_SYSTEM_BASE}/ndhm-benefit-type`,
  billingCodes: `${NDHM_SYSTEM_BASE}/ndhm-billing-codes`,
  claimExclusion: `${NDHM_SYSTEM_BASE}/ndhm-claim-exclusion`,
  coverageType: `${NDHM_SYSTEM_BASE}/ndhm-coverage-type`,
  formCode: `${NDHM_SYSTEM_BASE}/ndhm-form-code`,
  insurancePlanType: `${NDHM_SYSTEM_BASE}/ndhm-insuranceplan-type`,
  paymentType: `${NDHM_SYSTEM_BASE}/ndhm-payment-type`,
  planType: `${NDHM_SYSTEM_BASE}/ndhm-plan-type`,
  priceComponents: `${NDHM_SYSTEM_BASE}/ndhm-price-components`,
  programCode: `${NDHM_SYSTEM_BASE}/ndhm-program-code`,
  reasonCode: `${NDHM_SYSTEM_BASE}/ndhm-reason-code`,
  relatedClaimRelationshipCode: `${NDHM_SYSTEM_BASE}/ndhm-related-claim-relationship-code`,
  supportingInfoCategory: `${NDHM_SYSTEM_BASE}/ndhm-supportinginfo-category`,
  supportingInfoCode: `${NDHM_SYSTEM_BASE}/ndhm-supportinginfo-code`,
  taskCodes: `${NDHM_SYSTEM_BASE}/ndhm-task-codes`,
  taskInputTypeCode: `${NDHM_SYSTEM_BASE}/ndhm-task-input-type-code`,
  taskOutputType: `${NDHM_SYSTEM_BASE}/ndhm-task-output-type`,
  taskOutputValue: `${NDHM_SYSTEM_BASE}/ndhm-task-output-value`,
} as const;

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
