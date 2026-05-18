// FHIR R4 bundle builders for NHCX. The gateway expects every operation
// to land as a `Bundle` resource with `type: 'collection'` containing a
// root resource (CoverageEligibilityRequest, Claim, Communication) and
// the supporting actor resources (Patient, Coverage, Organization).
//
// We build the SHAPE the NHCX gateway requires — not the full FHIR R4
// schema. Where NHCX has its own profile constraints (HCX message
// handle, x-hcx-correlation-id header) those live on the JWE adapter
// envelope, not inside the FHIR Bundle. This module is intentionally
// pure (no DI, no external state) so it can be unit-tested without
// standing up the rest of the API.

import { randomUUID } from 'node:crypto';

import { nhcxIstIso } from './nhcx-protocol';

// ---- Inputs ---------------------------------------------------

export interface FhirActorIds {
  // NHCX participant codes for the sender (us) and receiver (payer).
  senderCode: string;
  receiverCode: string;
}

export interface FhirDeterminismDeps {
  // Optional factories used by snapshot tests to produce reproducible
  // bundles. Production callers omit both; defaults are crypto.randomUUID
  // and the system clock.
  uuid?: () => string;
  now?: () => Date;
}

export interface FhirPatientFields {
  // Plaintext display name + DoB. Encrypted IDs (Aadhaar, ABHA) live on
  // a separate Identifier on the Patient resource so the payer can
  // resolve membership without us round-tripping through the registry.
  fullName: string;
  dateOfBirth?: string | null; // YYYY-MM-DD
  gender?: 'male' | 'female' | 'other' | 'prefer_not_to_say' | null;
  // Hospital MRN — NHCX requires a local identifier on the Patient
  // resource for cross-referencing.
  hospitalMrn: string;
  // Optional verified identifiers — caller decides which to include.
  // Adapter logs redact these per CLAUDE.md rule 8 before write.
  abhaId?: string;
  policyNumber?: string;
  // P1.8 — PMJAY-specific identifiers. The bundle builder maps each
  // to its NRCeS-defined system URI + identifier 'type' coding so
  // the payer can disambiguate when the same patient carries
  // multiple government health IDs.
  pmjayBeneficiaryId?: string; // 'PMJAY' identifier type
  jhn?: string; // Jan Health Number — 'JHN' identifier type
  personalIdentifier?: string; // generic personal identifier — 'PI' type
  // Aadhaar — only included when the operator captured it with explicit
  // consent. Adapter logs MUST redact via RedactedLogger per rule 8.
  aadhaar?: string;
}

export interface FhirCoverageFields {
  // Insurer / TPA / SHA on the payer side.
  payerCode: string;
  payerDisplayName?: string;
  // Member id on the policy. May be the policy number for private
  // rails, the PMJAY beneficiary id for the gov rail.
  memberId: string;
  // P1.11 — Coverage richness. NHCX requires the policy holder
  // (subscriber/employer/family-head depending on the rail), the
  // policy period, and a coverage type coding. Optional because
  // PMJAY discovery flows omit the type entirely.
  policyHolderName?: string;
  periodStart?: string; // YYYY-MM-DD
  periodEnd?: string; // YYYY-MM-DD
  // FHIR Coverage.type code — typically 'EHCPOL' (extended health
  // care policy) for private cashless, 'PMJAY' for the gov rail.
  // The builder maps this to the canonical coverage-type system.
  coverageType?: 'EHCPOL' | 'PUBLICPOL' | 'PMJAY';
}

// P1.9 — Practitioner with HPIN. Used on Claim.careTeam[] to identify
// the treating physician with their NHA-issued Health Professional ID.
export interface FhirPractitionerFields {
  fullName: string;
  // 14-digit Health Professional Identifier issued by NHA HPR.
  hpin: string;
  // Optional registered qualification code (MD / MBBS / etc.).
  qualification?: string;
}

// P1.10 — Organization (hospital/provider) NHA identifiers. The
// builder also emits the payer's HFR Facility ID when available
// on the receiver actor. NPI / NIIP optional; HFR strongly
// recommended by NHCX.
export interface FhirOrganizationIdentifiers {
  // NHA Health Facility Registry ID (10-digit) — primary canonical
  // identifier for any registered hospital.
  hfrFacilityId?: string;
  // National Provider Identifier — NHA + IRDAI cross-rail code.
  npi?: string;
  // National Insurance Industry Portal code — used by some payers
  // to map participants back to their internal master.
  niip?: string;
}

// Slice BK — PMJAY runs eligibility with a single-purpose array per
// scenario (validation / benefits / auth-requirements). When
// `purpose` is omitted we keep the legacy private-rail combined value
// `['benefits','validation']` to preserve existing callers.
export type FhirEligibilityPurpose = 'validation' | 'benefits' | 'auth-requirements';

export interface FhirEligibilityRequestInput extends FhirDeterminismDeps {
  actors: FhirActorIds;
  patient: FhirPatientFields;
  coverage: FhirCoverageFields;
  serviceDate: string; // YYYY-MM-DD
  purpose?: FhirEligibilityPurpose;
}

// P1.13 — supportingInfo category split. NHCX requires structured
// data (diagnosis, history, clinical) to land under specific
// categories so the payer's adjudication pipeline can index them
// separately from unstructured proof-of-identity / OT-notes
// attachments. Each entry pairs a category code with either a
// value (structured) or an attachment reference (unstructured).
export type FhirSupportingInfoCategory =
  // structured
  | 'DIA' // diagnosis support
  | 'HDS' // history / discharge summary
  | 'CD' // clinical data
  | 'INF' // information
  // unstructured / attachment
  | 'POI' // proof of identity
  | 'OTHER';

export interface FhirSupportingInfoStructured {
  category: 'DIA' | 'HDS' | 'CD' | 'INF';
  text: string;
}

export interface FhirSupportingInfoAttachment {
  category: 'POI' | 'OTHER';
  // Reference to the Binary resource the payer pulls via a separate
  // Document operation. The builder emits a Binary/{id} URN.
  documentId: string;
  // Optional content-type for typed attachment guards. NHCX rejects
  // attachments without a contentType when the category is POI.
  contentType?: string;
  // Optional file size for attachment guards. The builder emits a
  // Communication-bound .size extension when both contentType and
  // sizeBytes are provided.
  sizeBytes?: number;
  // Optional SHA-256 hash for attachment integrity verification.
  // Hex-encoded. The builder maps to FHIR Attachment.hash.
  sha256?: string;
}

export type FhirSupportingInfoEntry =
  | FhirSupportingInfoStructured
  | FhirSupportingInfoAttachment;

// Discriminator — TypeScript's CFA can't narrow the union solely on a
// list of category strings, so we make the predicate explicit. Used
// once inside the bundle builder.
function isStructuredSupportingInfo(
  e: FhirSupportingInfoEntry,
): e is FhirSupportingInfoStructured {
  return e.category === 'DIA' || e.category === 'HDS' || e.category === 'CD' || e.category === 'INF';
}

// P1.14 — Mandatory date codes. PMJAY rejects bundles missing the
// admission/discharge/EDT codes for inpatient encounters. The
// builder maps each to a supportingInfo entry with the documented
// category code so the payer can index them on intake.
export interface FhirEncounterDates {
  // EDT — Estimated Date of Treatment (planned admission)
  edt?: string; // YYYY-MM-DD
  // ADDD — Admission Date (actual)
  addd?: string; // YYYY-MM-DD
  // DTH — Date of Discharge
  dth?: string; // YYYY-MM-DD
}

export interface FhirPreauthSubmitInput extends FhirDeterminismDeps {
  actors: FhirActorIds;
  patient: FhirPatientFields;
  coverage: FhirCoverageFields;
  // claimId is OUR local id — we expose it as Bundle.identifier so the
  // payer's response can cite it back even though they generate their
  // own claimRefNum.
  localClaimId: string;
  diagnosisIcdCode?: string;
  diagnosisDescription?: string;
  plannedProcedure?: string;
  procedureCode?: string;
  estimatedLengthOfStayDays?: number | null;
  requestedAmount?: number | null; // paise; converted to FHIR Money
  clinicalJustification?: string;
  // P1.9 — Optional treating-physician Practitioner. When supplied,
  // the builder emits a Practitioner resource with the HPIN identifier
  // and references it from Claim.careTeam[].
  practitioner?: FhirPractitionerFields;
  // P1.10 — Optional provider organization identifiers. The
  // sender's Organization resource carries these as Identifier
  // entries beside the participant code.
  providerIdentifiers?: FhirOrganizationIdentifiers;
  // P1.13 — Optional supportingInfo split. Existing
  // (diagnosis/procedure/estimatedLengthOfStayDays) keep working
  // unchanged; supportingInfo[] is additive and lets callers stamp
  // the documented DIA/HDS/CD/INF/POI/OTHER categories cleanly.
  supportingInfo?: FhirSupportingInfoEntry[];
  // P1.14 — Optional EDT / ADDD / DTH dates. Builder maps each to
  // a supportingInfo entry with the spec-mandated category code.
  encounterDates?: FhirEncounterDates;
}

export interface FhirClaimSubmitInput extends FhirPreauthSubmitInput {
  finalAmount: number; // paise
  // Document references — populated from the case's discharge_summary
  // / final_bill / OT_notes rows. Each ref points at our internal
  // document id; the payer pulls bytes via a follow-up Document
  // operation (deferred to Sprint 5).
  documentIds: string[];
}

export interface FhirCommunicationInput extends FhirDeterminismDeps {
  actors: FhirActorIds;
  // Identifies the original request the communication is in reply to.
  inReplyToRefNum?: string;
  payload: string;
}

// Slice BH — outbound `task/submit` bundle for PMJAY preauth cancel.
// Task.status = 'cancelled', Task.code carries the operation
// ('cancel'), Task.input[] carries the inputType + value pair
// (`ClaimNumber` + the previously-submitted preauthRefNum). Optional
// `note` records the operator's cancel reason on the audit trail.
export interface FhirTaskCancelInput extends FhirDeterminismDeps {
  actors: FhirActorIds;
  // The preauth reference issued by the gateway on the original
  // submit. PMJAY uses this as the `value` under the ClaimNumber
  // input.
  preauthRefNum: string;
  reason?: string;
}

// Slice BI — outbound `task/submit` bundle for PMJAY claim
// reprocess (CRC). Task.status = 'requested' (we're asking the
// payer to act), Task.code carries 'reprocess', Task.input[] has
// two entries: the ClaimNumber referencing the original claim, and
// a ReasonCode entry carrying 'claimrejected' or 'partialpayment'.
export type FhirTaskReprocessReason = 'claimrejected' | 'partialpayment';

export interface FhirTaskReprocessInput extends FhirDeterminismDeps {
  actors: FhirActorIds;
  // Gateway-issued claim reference from the original claim/submit.
  claimRefNum: string;
  reasonCode: FhirTaskReprocessReason;
  reason?: string;
}

// ---- Bundle helpers ------------------------------------------

interface BundleEntry {
  fullUrl: string;
  resource: Record<string, unknown>;
}

interface FhirBundle {
  resourceType: 'Bundle';
  id: string;
  meta: {
    lastUpdated: string;
    profile: string[];
  };
  identifier: { system: string; value: string };
  type: 'collection';
  timestamp: string;
  entry: BundleEntry[];
}

// P0.5 — NRCeS profiles. NHA migrated NHCX bundle profiles from the
// legacy HCX-IG (v0.7.1) to NRCeS (NDHM FHIR R4). Gateways validating
// against the NRCeS profile reject the old URIs; the NRCeS URIs are
// the canonical references for every NHCX bundle the hospital emits.
const NRCES_PROFILE_ELIGIBILITY =
  'https://nrces.in/ndhm/fhir/r4/StructureDefinition/CoverageEligibilityRequestBundle';
const NRCES_PROFILE_PREAUTH =
  'https://nrces.in/ndhm/fhir/r4/StructureDefinition/ClaimRequestBundle';
const NRCES_PROFILE_CLAIM =
  'https://nrces.in/ndhm/fhir/r4/StructureDefinition/ClaimRequestBundle';
const NRCES_PROFILE_COMMUNICATION =
  'https://nrces.in/ndhm/fhir/r4/StructureDefinition/CommunicationBundle';
const NRCES_PROFILE_TASK =
  'https://nrces.in/ndhm/fhir/r4/StructureDefinition/TaskBundle';
// Exported so the P3 PaymentReconciliation + InsurancePlan parsers
// share the canonical URI without duplicating the literal.
export const NRCES_PROFILE_PAYMENT_RECON =
  'https://nrces.in/ndhm/fhir/r4/StructureDefinition/PaymentReconciliationBundle';
export const NRCES_PROFILE_INSURANCE_PLAN =
  'https://nrces.in/ndhm/fhir/r4/StructureDefinition/InsurancePlanBundle';
// PMJAY-specific code system for the Task.code coding. Mirrors the
// `code` enum in the PMJAY supporting docs (cancel, reprocess).
const PMJAY_TASK_CODE_SYSTEM = 'https://payer.pmjay.nha.gov.in/CodeSystem/task-operation';
// Identifier system that PMJAY uses to reference the original
// claim/preauth on the Task.input[].value lookup.
const PMJAY_CLAIM_NUMBER_SYSTEM = 'https://hcx.pmjay.gov.in/v1/preauthorization';
// PMJAY-specific code system for reprocess reason codes
// ('claimrejected' / 'partialpayment') — appears as the
// Task.input[].type coding when the input carries a reason.
const PMJAY_TASK_REASON_SYSTEM = 'https://payer.pmjay.nha.gov.in/CodeSystem/task-reason';

// Bundle.identifier.system — NHA-recommended URL namespace for
// participant-issued Bundle identifiers. Mirrors the NRCeS profile URL.
const DEFAULT_BUNDLE_SYSTEM = 'https://nrces.in/ndhm/fhir/r4/Bundle';

const makeUrn = (uuid: () => string) => (resource: string): string =>
  `urn:uuid:${uuid()}-${resource}`;

// Canonical NRCeS / NHA identifier systems. Kept in one place so the
// gateway's URI-equality check sees the same string everywhere.
const IDENT_SYSTEM_MRN = 'urn:digisparsh:hospital:mrn';
const IDENT_SYSTEM_ABHA = 'https://healthid.abdm.gov.in';
const IDENT_SYSTEM_PMJAY = 'https://pmjay.gov.in/beneficiary';
const IDENT_SYSTEM_JHN = 'https://hcx.pmjay.nha.gov.in/jhn';
const IDENT_SYSTEM_PI = 'urn:nrces:fhir:r4:CodeSystem:personal-identifier';
const IDENT_SYSTEM_AADHAAR = 'https://uidai.gov.in';
const IDENT_SYSTEM_HPIN = 'https://hpr.abdm.gov.in/hpid';
const IDENT_SYSTEM_HFR = 'https://facility.abdm.gov.in';
const IDENT_SYSTEM_NPI = 'https://nha.gov.in/CodeSystem/npi';
const IDENT_SYSTEM_NIIP = 'https://niip.irdai.gov.in/participant';
const IDENT_TYPE_SYSTEM_V2 = 'http://terminology.hl7.org/CodeSystem/v2-0203';

function patientResource(p: FhirPatientFields, urn: string): Record<string, unknown> {
  const identifier: Array<Record<string, unknown>> = [
    {
      type: { coding: [{ system: IDENT_TYPE_SYSTEM_V2, code: 'MR' }] },
      system: IDENT_SYSTEM_MRN,
      value: p.hospitalMrn,
    },
  ];
  if (p.abhaId) {
    identifier.push({
      type: { coding: [{ system: IDENT_TYPE_SYSTEM_V2, code: 'ABHA' }] },
      system: IDENT_SYSTEM_ABHA,
      value: p.abhaId,
    });
  }
  // P1.8 — PMJAY / JHN / PI / Aadhaar identifier types. Order
  // matters for payer adjudication: the first identifier the payer
  // recognises wins, so we put the most-specific (PMJAY) first.
  if (p.pmjayBeneficiaryId) {
    identifier.push({
      type: { coding: [{ system: IDENT_TYPE_SYSTEM_V2, code: 'PMJAY' }] },
      system: IDENT_SYSTEM_PMJAY,
      value: p.pmjayBeneficiaryId,
    });
  }
  if (p.jhn) {
    identifier.push({
      type: { coding: [{ system: IDENT_TYPE_SYSTEM_V2, code: 'JHN' }] },
      system: IDENT_SYSTEM_JHN,
      value: p.jhn,
    });
  }
  if (p.personalIdentifier) {
    identifier.push({
      type: { coding: [{ system: IDENT_TYPE_SYSTEM_V2, code: 'PI' }] },
      system: IDENT_SYSTEM_PI,
      value: p.personalIdentifier,
    });
  }
  if (p.aadhaar) {
    identifier.push({
      type: { coding: [{ system: IDENT_TYPE_SYSTEM_V2, code: 'NI' }] },
      system: IDENT_SYSTEM_AADHAAR,
      value: p.aadhaar,
    });
  }
  const nameParts = p.fullName.trim().split(/\s+/);
  const family = nameParts.length > 1 ? (nameParts[nameParts.length - 1] ?? '') : '';
  const given = nameParts.length > 1 ? nameParts.slice(0, -1) : nameParts;
  const resource: Record<string, unknown> = {
    resourceType: 'Patient',
    id: urn,
    identifier,
    name: [
      {
        text: p.fullName,
        ...(family ? { family } : {}),
        ...(given.length > 0 ? { given } : {}),
      },
    ],
  };
  if (p.dateOfBirth) resource['birthDate'] = p.dateOfBirth;
  if (p.gender && p.gender !== 'prefer_not_to_say') resource['gender'] = p.gender;
  return resource;
}

function organizationResource(
  code: string,
  displayName: string | undefined,
  // P1.10 — optional NHA identifiers (HFR / NPI / NIIP). The participant
  // code stays as the first identifier for back-compat with existing
  // payer-side allowlists.
  extra?: FhirOrganizationIdentifiers,
): Record<string, unknown> {
  const identifier: Array<Record<string, unknown>> = [
    { system: 'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-organization', value: code },
  ];
  if (extra?.hfrFacilityId) {
    identifier.push({
      type: { coding: [{ system: IDENT_TYPE_SYSTEM_V2, code: 'HFR' }] },
      system: IDENT_SYSTEM_HFR,
      value: extra.hfrFacilityId,
    });
  }
  if (extra?.npi) {
    identifier.push({
      type: { coding: [{ system: IDENT_TYPE_SYSTEM_V2, code: 'NPI' }] },
      system: IDENT_SYSTEM_NPI,
      value: extra.npi,
    });
  }
  if (extra?.niip) {
    identifier.push({
      type: { coding: [{ system: IDENT_TYPE_SYSTEM_V2, code: 'NIIP' }] },
      system: IDENT_SYSTEM_NIIP,
      value: extra.niip,
    });
  }
  return {
    resourceType: 'Organization',
    id: `urn:digisparsh:org:${code}`,
    identifier,
    name: displayName ?? code,
  };
}

function practitionerResource(
  p: FhirPractitionerFields,
  urn: string,
): Record<string, unknown> {
  const resource: Record<string, unknown> = {
    resourceType: 'Practitioner',
    id: urn,
    identifier: [
      {
        type: { coding: [{ system: IDENT_TYPE_SYSTEM_V2, code: 'HPIN' }] },
        system: IDENT_SYSTEM_HPIN,
        value: p.hpin,
      },
    ],
    name: [{ text: p.fullName }],
  };
  if (p.qualification) {
    resource['qualification'] = [
      {
        code: { text: p.qualification },
      },
    ];
  }
  return resource;
}

function coverageResource(
  c: FhirCoverageFields,
  patientUrn: string,
  payerUrn: string,
  urn: string,
): Record<string, unknown> {
  const resource: Record<string, unknown> = {
    resourceType: 'Coverage',
    id: urn,
    status: 'active',
    subscriberId: c.memberId,
    beneficiary: { reference: patientUrn },
    payor: [{ reference: payerUrn }],
  };
  // P1.11 — Coverage.type / period / policyHolder. NHCX rejects
  // private-rail bundles missing the type coding; PMJAY rejects
  // bundles missing the period.
  if (c.coverageType) {
    resource['type'] = {
      coding: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/coverage-selfpay',
          code: c.coverageType,
        },
      ],
    };
  }
  if (c.policyHolderName) {
    resource['policyHolder'] = { display: c.policyHolderName };
  }
  if (c.periodStart || c.periodEnd) {
    resource['period'] = {
      ...(c.periodStart ? { start: c.periodStart } : {}),
      ...(c.periodEnd ? { end: c.periodEnd } : {}),
    };
  }
  return resource;
}

// ---- Public builders ----------------------------------------

export function buildEligibilityRequestBundle(input: FhirEligibilityRequestInput): FhirBundle {
  const uuid = input.uuid ?? randomUUID;
  const ts = nhcxIstIso((input.now ?? (() => new Date()))());
  const URN = makeUrn(uuid);
  const bundleId = uuid();
  const patientUrn = URN('patient');
  const insurerUrn = URN('insurer');
  const providerUrn = URN('provider');
  const coverageUrn = URN('coverage');
  const requestUrn = URN('eligibility-request');

  const purpose: FhirEligibilityPurpose[] = input.purpose
    ? [input.purpose]
    : ['benefits', 'validation'];

  const eligibilityRequest: Record<string, unknown> = {
    resourceType: 'CoverageEligibilityRequest',
    id: requestUrn,
    status: 'active',
    purpose,
    patient: { reference: patientUrn },
    servicedDate: input.serviceDate,
    created: ts,
    insurer: { reference: insurerUrn },
    provider: { reference: providerUrn },
    insurance: [{ coverage: { reference: coverageUrn } }],
  };

  return {
    resourceType: 'Bundle',
    id: bundleId,
    meta: {
      lastUpdated: ts,
      profile: [NRCES_PROFILE_ELIGIBILITY],
    },
    identifier: { system: DEFAULT_BUNDLE_SYSTEM, value: bundleId },
    type: 'collection',
    timestamp: ts,
    entry: [
      { fullUrl: requestUrn, resource: eligibilityRequest },
      { fullUrl: patientUrn, resource: patientResource(input.patient, patientUrn) },
      {
        fullUrl: insurerUrn,
        resource: organizationResource(input.coverage.payerCode, input.coverage.payerDisplayName),
      },
      { fullUrl: providerUrn, resource: organizationResource(input.actors.senderCode, undefined) },
      {
        fullUrl: coverageUrn,
        resource: coverageResource(input.coverage, patientUrn, insurerUrn, coverageUrn),
      },
    ],
  };
}

function claimResource(
  input: FhirPreauthSubmitInput,
  use: 'preauthorization' | 'claim',
  patientUrn: string,
  insurerUrn: string,
  providerUrn: string,
  coverageUrn: string,
  urn: string,
  ts: string,
  finalAmountPaise?: number,
  documentIds?: string[],
  practitionerUrn?: string,
): Record<string, unknown> {
  const amount = finalAmountPaise ?? input.requestedAmount ?? 0;
  const claim: Record<string, unknown> = {
    resourceType: 'Claim',
    id: urn,
    identifier: [
      {
        system: 'urn:digisparsh:claim:id',
        value: input.localClaimId,
      },
    ],
    status: 'active',
    // P1.12 — NHCX uses SNOMED 737481003 ("Inpatient encounter") as
    // the canonical Claim.type for hospitalization. We keep the HL7
    // institutional code as a parallel coding for back-compat with
    // payer-side dashboards that haven't migrated to SNOMED yet.
    type: {
      coding: [
        {
          system: 'http://snomed.info/sct',
          code: '737481003',
          display: 'Inpatient encounter',
        },
        {
          system: 'http://terminology.hl7.org/CodeSystem/claim-type',
          code: 'institutional',
        },
      ],
    },
    use,
    patient: { reference: patientUrn },
    created: ts,
    insurer: { reference: insurerUrn },
    provider: { reference: providerUrn },
    priority: { coding: [{ code: 'normal' }] },
    insurance: [
      {
        sequence: 1,
        focal: true,
        coverage: { reference: coverageUrn },
      },
    ],
    total: { value: amount / 100, currency: 'INR' },
  };
  // P1.12 — careTeam[] references the treating physician's
  // Practitioner resource when one was supplied. The role coding
  // marks the entry as 'primary' so payers can identify the
  // attending physician at a glance.
  if (practitionerUrn) {
    claim['careTeam'] = [
      {
        sequence: 1,
        provider: { reference: practitionerUrn },
        role: {
          coding: [
            {
              system: 'http://terminology.hl7.org/CodeSystem/claimcareteamrole',
              code: 'primary',
            },
          ],
        },
      },
    ];
  }
  if (input.diagnosisIcdCode || input.diagnosisDescription) {
    claim['diagnosis'] = [
      {
        sequence: 1,
        diagnosisCodeableConcept: {
          ...(input.diagnosisIcdCode
            ? {
                coding: [
                  {
                    system: 'http://hl7.org/fhir/sid/icd-10',
                    code: input.diagnosisIcdCode,
                    ...(input.diagnosisDescription
                      ? { display: input.diagnosisDescription }
                      : {}),
                  },
                ],
              }
            : {}),
          ...(input.diagnosisDescription ? { text: input.diagnosisDescription } : {}),
        },
      },
    ];
  }
  if (input.plannedProcedure || input.procedureCode) {
    claim['procedure'] = [
      {
        sequence: 1,
        procedureCodeableConcept: {
          ...(input.procedureCode
            ? {
                coding: [
                  {
                    system: 'urn:digisparsh:procedure:code',
                    code: input.procedureCode,
                    ...(input.plannedProcedure ? { display: input.plannedProcedure } : {}),
                  },
                ],
              }
            : {}),
          ...(input.plannedProcedure ? { text: input.plannedProcedure } : {}),
        },
      },
    ];
  }
  // P1.13 / P1.14 — supportingInfo is the union of:
  //   1. estimatedLengthOfStay (legacy quantity, kept for back-compat)
  //   2. structured entries (DIA / HDS / CD / INF) from input.supportingInfo
  //   3. encounterDates (EDT / ADDD / DTH) mapped per category code
  //   4. attachment entries (POI / OTHER) from input.supportingInfo
  //   5. legacy documentIds (kept for back-compat; emits OTHER-category)
  // Each entry gets a unique sequence so payer adjudication can cite
  // them back by index.
  const supportingInfo: Array<Record<string, unknown>> = [];
  let seq = 0;

  if (input.estimatedLengthOfStayDays && input.estimatedLengthOfStayDays > 0) {
    seq += 1;
    supportingInfo.push({
      sequence: seq,
      category: { coding: [{ code: 'hospitalized' }] },
      valueQuantity: { value: input.estimatedLengthOfStayDays, unit: 'days' },
    });
  }
  // P1.14 — mandatory date codes EDT / ADDD / DTH per NHCX PMJAY
  // §5.6. Each gets its own supportingInfo entry with the spec
  // category code so the payer's intake pipeline can pull them by
  // category without scanning text.
  const ds = input.encounterDates;
  if (ds?.edt) {
    seq += 1;
    supportingInfo.push({
      sequence: seq,
      category: {
        coding: [
          {
            system: 'https://nrces.in/ndhm/fhir/r4/CodeSystem/claim-supporting-info-category',
            code: 'EDT',
            display: 'Estimated date of treatment',
          },
        ],
      },
      valueString: ds.edt,
    });
  }
  if (ds?.addd) {
    seq += 1;
    supportingInfo.push({
      sequence: seq,
      category: {
        coding: [
          {
            system: 'https://nrces.in/ndhm/fhir/r4/CodeSystem/claim-supporting-info-category',
            code: 'ADDD',
            display: 'Admission date',
          },
        ],
      },
      valueString: ds.addd,
    });
  }
  if (ds?.dth) {
    seq += 1;
    supportingInfo.push({
      sequence: seq,
      category: {
        coding: [
          {
            system: 'https://nrces.in/ndhm/fhir/r4/CodeSystem/claim-supporting-info-category',
            code: 'DTH',
            display: 'Date of discharge',
          },
        ],
      },
      valueString: ds.dth,
    });
  }
  // P1.13 — structured + attachment categories. The split keeps
  // DIA / HDS / CD / INF from being conflated with POI / OTHER on
  // the payer side, which is what their adjudication pipelines
  // assume per the NHCX PMJAY Integration Handbook §6.2.
  for (const e of input.supportingInfo ?? []) {
    seq += 1;
    const category = {
      coding: [
        {
          system: 'https://nrces.in/ndhm/fhir/r4/CodeSystem/claim-supporting-info-category',
          code: e.category,
        },
      ],
    };
    if (isStructuredSupportingInfo(e)) {
      supportingInfo.push({
        sequence: seq,
        category,
        valueString: e.text,
      });
    } else {
      // POI / OTHER attachment branch. Optional contentType /
      // sizeBytes / sha256 are typed-attachment guards; NHCX
      // rejects POI attachments without contentType (the call site
      // surfaces a validation error earlier).
      const valueAttachment: Record<string, unknown> = {
        url: `Binary/${e.documentId}`,
      };
      if (e.contentType) valueAttachment['contentType'] = e.contentType;
      if (typeof e.sizeBytes === 'number') valueAttachment['size'] = e.sizeBytes;
      if (e.sha256) valueAttachment['hash'] = e.sha256;
      supportingInfo.push({
        sequence: seq,
        category,
        valueAttachment,
      });
    }
  }
  if (input.clinicalJustification) {
    claim['note'] = [{ text: input.clinicalJustification }];
  }
  // Legacy documentIds — keep working for callers that haven't
  // migrated to the typed supportingInfo[] yet. Each ID lands as
  // an OTHER-category attachment with no extra guards (those need
  // explicit contentType + size from the typed API).
  if (documentIds && documentIds.length > 0) {
    for (const docId of documentIds) {
      seq += 1;
      supportingInfo.push({
        sequence: seq,
        category: {
          coding: [
            {
              system: 'https://nrces.in/ndhm/fhir/r4/CodeSystem/claim-supporting-info-category',
              code: 'OTHER',
            },
          ],
        },
        valueAttachment: { url: `Binary/${docId}` },
      });
    }
  }

  if (supportingInfo.length > 0) {
    claim['supportingInfo'] = supportingInfo;
  }
  return claim;
}

export function buildPreauthSubmitBundle(input: FhirPreauthSubmitInput): FhirBundle {
  const uuid = input.uuid ?? randomUUID;
  const ts = nhcxIstIso((input.now ?? (() => new Date()))());
  const URN = makeUrn(uuid);
  const bundleId = uuid();
  const patientUrn = URN('patient');
  const insurerUrn = URN('insurer');
  const providerUrn = URN('provider');
  const coverageUrn = URN('coverage');
  const claimUrn = URN('claim');
  // P1.9 — only mint a Practitioner URN when the caller supplied
  // practitioner fields. Existing call sites that don't pass one
  // see a 5-resource bundle exactly as before.
  const practitionerUrn = input.practitioner ? URN('practitioner') : undefined;

  const entry: Array<{ fullUrl: string; resource: Record<string, unknown> }> = [
    {
      fullUrl: claimUrn,
      resource: claimResource(
        input,
        'preauthorization',
        patientUrn,
        insurerUrn,
        providerUrn,
        coverageUrn,
        claimUrn,
        ts,
        undefined,
        undefined,
        practitionerUrn,
      ),
    },
    { fullUrl: patientUrn, resource: patientResource(input.patient, patientUrn) },
    {
      fullUrl: insurerUrn,
      resource: organizationResource(input.coverage.payerCode, input.coverage.payerDisplayName),
    },
    {
      fullUrl: providerUrn,
      resource: organizationResource(input.actors.senderCode, undefined, input.providerIdentifiers),
    },
    {
      fullUrl: coverageUrn,
      resource: coverageResource(input.coverage, patientUrn, insurerUrn, coverageUrn),
    },
  ];
  if (input.practitioner && practitionerUrn) {
    entry.push({
      fullUrl: practitionerUrn,
      resource: practitionerResource(input.practitioner, practitionerUrn),
    });
  }
  return {
    resourceType: 'Bundle',
    id: bundleId,
    meta: {
      lastUpdated: ts,
      profile: [NRCES_PROFILE_PREAUTH],
    },
    identifier: { system: DEFAULT_BUNDLE_SYSTEM, value: bundleId },
    type: 'collection',
    timestamp: ts,
    entry,
  };
}

export function buildClaimSubmitBundle(input: FhirClaimSubmitInput): FhirBundle {
  const bundle = buildPreauthSubmitBundle(input);
  // Replace the Claim entry with the use='claim' variant + finalAmount
  // + documentIds wired into supportingInfo.
  const patientUrn = (bundle.entry.find((e) => e.resource['resourceType'] === 'Patient')?.fullUrl ?? '') as string;
  const insurerUrn = (bundle.entry.find((e) => e.resource['resourceType'] === 'Organization' && (e.resource['identifier'] as Array<{ value: string }>)[0]?.value === input.coverage.payerCode)?.fullUrl ?? '') as string;
  const providerUrn = (bundle.entry.find((e) => e.resource['resourceType'] === 'Organization' && (e.resource['identifier'] as Array<{ value: string }>)[0]?.value === input.actors.senderCode)?.fullUrl ?? '') as string;
  const coverageUrn = (bundle.entry.find((e) => e.resource['resourceType'] === 'Coverage')?.fullUrl ?? '') as string;
  const claimEntryIdx = bundle.entry.findIndex((e) => e.resource['resourceType'] === 'Claim');
  const claimUrn = bundle.entry[claimEntryIdx]?.fullUrl ?? makeUrn(input.uuid ?? randomUUID)('claim');
  const practitionerUrn = bundle.entry.find((e) => e.resource['resourceType'] === 'Practitioner')?.fullUrl;

  bundle.entry[claimEntryIdx] = {
    fullUrl: claimUrn,
    resource: claimResource(
      input,
      'claim',
      patientUrn,
      insurerUrn,
      providerUrn,
      coverageUrn,
      claimUrn,
      bundle.timestamp,
      input.finalAmount,
      input.documentIds,
      practitionerUrn,
    ),
  };
  bundle.meta.profile = [NRCES_PROFILE_CLAIM];
  return bundle;
}

export function buildCommunicationBundle(input: FhirCommunicationInput): FhirBundle {
  const uuid = input.uuid ?? randomUUID;
  const ts = nhcxIstIso((input.now ?? (() => new Date()))());
  const URN = makeUrn(uuid);
  const bundleId = uuid();
  const senderUrn = URN('sender');
  const recipientUrn = URN('recipient');
  const communicationUrn = URN('communication');

  const communication: Record<string, unknown> = {
    resourceType: 'Communication',
    id: communicationUrn,
    status: 'completed',
    sent: ts,
    sender: { reference: senderUrn },
    recipient: [{ reference: recipientUrn }],
    payload: [{ contentString: input.payload }],
  };
  if (input.inReplyToRefNum) {
    communication['inResponseTo'] = [
      {
        identifier: {
          system: 'urn:digisparsh:claim:payerRefNum',
          value: input.inReplyToRefNum,
        },
      },
    ];
  }

  return {
    resourceType: 'Bundle',
    id: bundleId,
    meta: {
      lastUpdated: ts,
      profile: [NRCES_PROFILE_COMMUNICATION],
    },
    identifier: { system: DEFAULT_BUNDLE_SYSTEM, value: bundleId },
    type: 'collection',
    timestamp: ts,
    entry: [
      { fullUrl: communicationUrn, resource: communication },
      { fullUrl: senderUrn, resource: organizationResource(input.actors.senderCode, undefined) },
      { fullUrl: recipientUrn, resource: organizationResource(input.actors.receiverCode, undefined) },
    ],
  };
}

// Slice BH — Task FHIR bundle for PMJAY preauth cancel. The shape
// mirrors the `task/submit` payload documented in
// `NHCX HMIS\HIMS-PMJAY suppporting docs\NHCX_APIs to be called
// based on scenario.xlsx` row "Preauth cancel": `code: 'cancel'`,
// `inputType: 'ClaimNumber'` carried as a Task resource with the
// payer-side claim reference under `Task.input[].value.identifier`.
//
// Task.status = 'cancelled' rather than 'requested' because in
// PMJAY's semantics the hospital is asserting the cancellation,
// not requesting one — payers ack-or-reject, they don't cancel
// on our behalf.
export function buildTaskCancelBundle(input: FhirTaskCancelInput): FhirBundle {
  const uuid = input.uuid ?? randomUUID;
  const ts = nhcxIstIso((input.now ?? (() => new Date()))());
  const URN = makeUrn(uuid);
  const bundleId = uuid();
  const senderUrn = URN('sender');
  const recipientUrn = URN('recipient');
  const taskUrn = URN('task');

  const task: Record<string, unknown> = {
    resourceType: 'Task',
    id: taskUrn,
    status: 'cancelled',
    intent: 'order',
    authoredOn: ts,
    requester: { reference: senderUrn },
    owner: { reference: recipientUrn },
    code: {
      coding: [
        {
          system: PMJAY_TASK_CODE_SYSTEM,
          code: 'cancel',
          display: 'Cancel preauthorization',
        },
      ],
    },
    input: [
      {
        type: {
          coding: [
            {
              system: PMJAY_TASK_CODE_SYSTEM,
              code: 'ClaimNumber',
              display: 'Payer-issued claim number',
            },
          ],
        },
        valueIdentifier: {
          system: PMJAY_CLAIM_NUMBER_SYSTEM,
          value: input.preauthRefNum,
        },
      },
    ],
  };
  if (input.reason) {
    task['note'] = [{ text: input.reason, time: ts }];
  }

  return {
    resourceType: 'Bundle',
    id: bundleId,
    meta: {
      lastUpdated: ts,
      profile: [NRCES_PROFILE_TASK],
    },
    identifier: { system: DEFAULT_BUNDLE_SYSTEM, value: bundleId },
    type: 'collection',
    timestamp: ts,
    entry: [
      { fullUrl: taskUrn, resource: task },
      { fullUrl: senderUrn, resource: organizationResource(input.actors.senderCode, undefined) },
      { fullUrl: recipientUrn, resource: organizationResource(input.actors.receiverCode, undefined) },
    ],
  };
}

// Slice BI — Task FHIR bundle for PMJAY claim reprocess (CRC).
// Mirrors the cancel bundle shape but with two Task.input entries:
//   1. ClaimNumber → the gateway-issued claimRefNum from the
//      original claim/submit, so the payer can look up the case.
//   2. ReasonCode → 'claimrejected' or 'partialpayment', so the
//      payer's CRC workflow knows which queue to put the
//      re-evaluation in.
//
// Task.status = 'requested' (vs cancel's 'cancelled') because the
// hospital is asking the payer to act, not asserting a state on
// their behalf.
export function buildTaskReprocessBundle(input: FhirTaskReprocessInput): FhirBundle {
  const uuid = input.uuid ?? randomUUID;
  const ts = nhcxIstIso((input.now ?? (() => new Date()))());
  const URN = makeUrn(uuid);
  const bundleId = uuid();
  const senderUrn = URN('sender');
  const recipientUrn = URN('recipient');
  const taskUrn = URN('task');

  const reasonDisplay =
    input.reasonCode === 'claimrejected'
      ? 'Re-evaluate rejected claim'
      : 'Re-evaluate short-paid claim';

  const task: Record<string, unknown> = {
    resourceType: 'Task',
    id: taskUrn,
    status: 'requested',
    intent: 'order',
    authoredOn: ts,
    requester: { reference: senderUrn },
    owner: { reference: recipientUrn },
    code: {
      coding: [
        {
          system: PMJAY_TASK_CODE_SYSTEM,
          code: 'reprocess',
          display: 'Reprocess claim',
        },
      ],
    },
    input: [
      {
        type: {
          coding: [
            {
              system: PMJAY_TASK_CODE_SYSTEM,
              code: 'ClaimNumber',
              display: 'Payer-issued claim number',
            },
          ],
        },
        valueIdentifier: {
          system: PMJAY_CLAIM_NUMBER_SYSTEM,
          value: input.claimRefNum,
        },
      },
      {
        type: {
          coding: [
            {
              system: PMJAY_TASK_REASON_SYSTEM,
              code: 'ReasonCode',
              display: 'Reprocess reason',
            },
          ],
        },
        valueCoding: {
          system: PMJAY_TASK_REASON_SYSTEM,
          code: input.reasonCode,
          display: reasonDisplay,
        },
      },
    ],
  };
  if (input.reason) {
    task['note'] = [{ text: input.reason, time: ts }];
  }

  return {
    resourceType: 'Bundle',
    id: bundleId,
    meta: {
      lastUpdated: ts,
      profile: [NRCES_PROFILE_TASK],
    },
    identifier: { system: DEFAULT_BUNDLE_SYSTEM, value: bundleId },
    type: 'collection',
    timestamp: ts,
    entry: [
      { fullUrl: taskUrn, resource: task },
      { fullUrl: senderUrn, resource: organizationResource(input.actors.senderCode, undefined) },
      { fullUrl: recipientUrn, resource: organizationResource(input.actors.receiverCode, undefined) },
    ],
  };
}

export type { FhirBundle };
