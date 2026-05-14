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
}

export interface FhirCoverageFields {
  // Insurer / TPA / SHA on the payer side.
  payerCode: string;
  payerDisplayName?: string;
  // Member id on the policy. May be the policy number for private
  // rails, the PMJAY beneficiary id for the gov rail.
  memberId: string;
  // Optional NDHM coverage-type code (e.g. 'PUBLICPOL', 'EHCPOL') from
  // `https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-coverage-type`. When
  // present we stamp Coverage.type per the NRCES profile.
  coverageTypeCode?: string;
  coverageTypeDisplay?: string;
  // Optional policy validity window for Coverage.period.
  periodStart?: string; // YYYY-MM-DD
  periodEnd?: string; // YYYY-MM-DD
}

// Treating doctor — projected into a Practitioner resource and
// referenced from Claim.careTeam. Per NRCES ClaimBundle profile, every
// preauth/claim must carry the doctor of record under careTeam[].
export interface FhirPractitionerFields {
  // HPR (Healthcare Professional Registry) ID — preferred when present.
  hprId?: string;
  // Fallback identifier: MCI / state council registration number.
  registrationNumber?: string;
  registrationSystem?: string; // e.g. council URL
  fullName: string;
  qualification?: string; // free-text MBBS/MD/MS/...
  role?: 'attender' | 'admitting' | 'referring' | 'consulting' | 'primary';
}

// One billable line on Claim.item[] — package items for PMJAY, line-
// itemised final bill for private. NRCES profile mandates item[] with
// productOrService coding + unitPrice + net.
export interface FhirClaimLineItem {
  // 1-based sequence number; if omitted we assign by array index.
  sequence?: number;
  // Service / package / drug code. PMJAY rail uses HBP package codes;
  // private rail typically uses ndhm-billing-codes or SNOMED.
  code: string;
  codeSystem?: string; // defaults to NDHM billing-codes system
  display?: string;
  // Quantity (defaults to 1).
  quantity?: number;
  // Unit price in paise. We convert to FHIR Money (rupees) on emit.
  unitPricePaise: number;
  // Optional override; when absent we compute quantity * unitPrice.
  netPricePaise?: number;
  servicedDate?: string; // YYYY-MM-DD; date the service was rendered
}

// Slice BK — PMJAY runs eligibility with a single-purpose array per
// scenario (validation / benefits / auth-requirements / discovery).
// When `purpose` is omitted we keep the legacy private-rail combined
// value `['benefits','validation']` to preserve existing callers.
// The 'discovery' value is required by NRCES NHCX for the initial
// policy-lookup variant of CoverageEligibilityRequest.
export type FhirEligibilityPurpose =
  | 'validation'
  | 'benefits'
  | 'auth-requirements'
  | 'discovery';

export interface FhirEligibilityRequestInput extends FhirDeterminismDeps {
  actors: FhirActorIds;
  patient: FhirPatientFields;
  coverage: FhirCoverageFields;
  serviceDate: string; // YYYY-MM-DD
  purpose?: FhirEligibilityPurpose;
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
  // Optional SNOMED CT code for the same diagnosis. NRCES examples
  // ride SNOMED alongside ICD-10; when present we emit both codings
  // under diagnosis[].diagnosisCodeableConcept.coding[].
  diagnosisSnomedCode?: string;
  diagnosisDescription?: string;
  plannedProcedure?: string;
  // Procedure coded value. When `procedureSystem` is omitted we default
  // to SNOMED CT (NRCES NHCX preference). The legacy private-rail
  // `urn:digisparsh:procedure:code` is allowed only when callers
  // explicitly set it.
  procedureCode?: string;
  procedureSystem?: string;
  // Optional NHA HBP package code for PMJAY rail; emitted as a
  // second `coding` entry on the same procedure CodeableConcept.
  hbpPackageCode?: string;
  estimatedLengthOfStayDays?: number | null;
  requestedAmount?: number | null; // paise; converted to FHIR Money
  clinicalJustification?: string;
  // Optional admission window — projected to Claim.billablePeriod
  // (NRCES profile mandate). Use ISO 8601 datetime when including a
  // clock; date-only is acceptable for planned admissions.
  admissionStart?: string;
  admissionEnd?: string;
  // Treating doctor for the case — referenced from Claim.careTeam[0].
  // Optional only because legacy callers may not yet have HPR data
  // wired, but every production preauth bundle SHOULD carry one.
  practitioner?: FhirPractitionerFields;
  // Optional line-itemised bill. PMJAY: HBP package items; private:
  // estimated procedure components. Projects to Claim.item[].
  lineItems?: FhirClaimLineItem[];
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

// `insuranceplan/request` outbound TaskBundle. Per the NRCES IG
// example `Bundle-TaskBundleForInsurancePlanRequest-example-01.json`
// (corpus path: md/nrces.in/ndhm/fhir/r4/), the lookup-by-policy-
// number flow ships a Task with `code: financialtaskcode/poll`,
// description "Give the details of Insurance plan linked with the
// given policy number", and two `input[]` entries keyed on the
// NDHM task-input-type-code system: `policyNumber` + `providerId`.
//
// This sits at the head of the HCX correlation chain — the
// returned correlation id is the one we stamp into Claim.
// insuranceCorrelationId so every later stage (coverage, preauth,
// claim, payment) can reuse it on the wire.
export interface FhirInsurancePlanRequestInput extends FhirDeterminismDeps {
  actors: FhirActorIds;
  // The policy number the hospital wants the payer to look up. Goes
  // onto `Task.input[0].valueString` under code 'policyNumber'.
  policyNumber: string;
  // Provider identifier the payer uses to authenticate the lookup
  // (typically the HFR ID or the payer-specific provider code).
  // Goes onto `Task.input[1].valueString` under code 'providerId'.
  providerId: string;
  // Optional human-friendly insurer name for the recipient
  // Organization resource. Defaults to the payer code itself.
  payerDisplayName?: string;
  // Optional human-friendly hospital name for the requester
  // Organization resource.
  hospitalDisplayName?: string;
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
    // v3-Confidentiality coding ("V" — very restricted) per NRCES
    // examples; mandatory on PII-bearing bundles.
    security?: Array<{ system: string; code: string; display?: string }>;
  };
  identifier?: { system?: string; value: string };
  type: 'collection';
  timestamp: string;
  entry: BundleEntry[];
}

// --- NRCES NHCX (ABDM v6.5.0) profile URLs --------------------
// Source: md/nrces.in/ndhm/fhir/r4/hcx-profile.html.md (lines 36–43).
// Authoritative validator base is `https://nrces.in/ndhm/fhir/r4/...`.
// Previously this module stamped `https://ig.hcxprotocol.io/v0.7.1/...`
// URLs which trace to the legacy HCX 0.7.1 reference and are rejected
// by current NHCX validators.
const NRCES_BASE = 'https://nrces.in/ndhm/fhir/r4';
const NRCES_SD = `${NRCES_BASE}/StructureDefinition`;
const NRCES_CS = `${NRCES_BASE}/CodeSystem`;

const PROFILE_ELIGIBILITY_BUNDLE = `${NRCES_SD}/CoverageEligibilityRequestBundle`;
const PROFILE_CLAIM_BUNDLE = `${NRCES_SD}/ClaimBundle`;
const PROFILE_COMMUNICATION_BUNDLE = `${NRCES_SD}/CommunicationBundle`;
const PROFILE_TASK_BUNDLE = `${NRCES_SD}/TaskBundle`;

// Profiles for contained resources — NRCES IG declares per-resource
// profiles which all must be stamped via `meta.profile` for validator
// pass. Where the IG profile name is unconfirmed in the corpus we
// default to the NRCES StructureDefinition URN convention.
const PROFILE_PATIENT = `${NRCES_SD}/Patient`;
const PROFILE_ORGANIZATION = `${NRCES_SD}/Organization`;
const PROFILE_COVERAGE = `${NRCES_SD}/Coverage`;
const PROFILE_CLAIM = `${NRCES_SD}/Claim`;
const PROFILE_PRACTITIONER = `${NRCES_SD}/Practitioner`;
const PROFILE_COVERAGE_ELIGIBILITY_REQUEST = `${NRCES_SD}/CoverageEligibilityRequest`;
const PROFILE_COMMUNICATION = `${NRCES_SD}/Communication`;
const PROFILE_TASK = `${NRCES_SD}/Task`;

// --- Code systems used inside bundles -------------------------
const SYS_NDHM_ORGANIZATION = `${NRCES_CS}/ndhm-organization`;
const SYS_NDHM_COVERAGE_TYPE = `${NRCES_CS}/ndhm-coverage-type`;
const SYS_NDHM_BILLING_CODES = `${NRCES_CS}/ndhm-billing-codes`;
const SYS_NDHM_SUPPORTINGINFO_CATEGORY = `${NRCES_CS}/ndhm-supportinginfo-category`;
const SYS_NDHM_TASK_CODES = `${NRCES_CS}/ndhm-task-codes`;
const SYS_NDHM_TASK_INPUT_TYPE = `${NRCES_CS}/ndhm-task-input-type-code`;
const SYS_NDHM_REASON_CODE = `${NRCES_CS}/ndhm-reason-code`;
const SYS_SNOMED = 'http://snomed.info/sct';
const SYS_ICD10 = 'http://hl7.org/fhir/sid/icd-10';
const SYS_HPR = 'https://hpr.abdm.gov.in';
const SYS_V3_CONFIDENTIALITY = 'http://terminology.hl7.org/CodeSystem/v3-Confidentiality';
// HL7 `financialtaskcode` system — used by NRCES InsurancePlanRequest
// TaskBundles to mark the Task as a 'poll' (gateway-side lookup).
const SYS_FINANCIAL_TASK_CODE = 'http://terminology.hl7.org/CodeSystem/financialtaskcode';

// SNOMED CT codes referenced from NRCES bundle examples.
const SNOMED_INPATIENT_CARE = '737481003'; // "Inpatient care management (procedure)"
const SNOMED_DISCHARGE_DIAGNOSIS = '89100005'; // "Final diagnosis (discharge)"
const SNOMED_HOSPITALISATION = '32485007'; // supportingInfo hospitalisation marker

// Confidentiality coding mandated on PII-bearing bundles (NRCES
// ClaimBundle / CoverageEligibilityRequestBundle examples).
const META_SECURITY_V_RESTRICTED = [
  { system: SYS_V3_CONFIDENTIALITY, code: 'V', display: 'very restricted' },
];

// PMJAY-specific legacy task code system (retained for back-compat
// with older payer integrations). New code paths emit
// `SYS_NDHM_TASK_CODES` per NRCES; PMJAY adapters that require the
// payer-specific URI can pass `taskCodeSystem` overrides.
const PMJAY_TASK_CODE_SYSTEM = 'https://payer.pmjay.nha.gov.in/CodeSystem/task-operation';
// Identifier system that PMJAY uses to reference the original
// claim/preauth on the Task.input[].value lookup.
const PMJAY_CLAIM_NUMBER_SYSTEM = 'https://hcx.pmjay.gov.in/v1/preauthorization';
// PMJAY-specific code system for reprocess reason codes
// ('claimrejected' / 'partialpayment') — appears as the
// Task.input[].type coding when the input carries a reason.
const PMJAY_TASK_REASON_SYSTEM = 'https://payer.pmjay.nha.gov.in/CodeSystem/task-reason';

const makeUrn = (uuid: () => string) => (resource: string): string =>
  `urn:uuid:${uuid()}-${resource}`;

function patientResource(p: FhirPatientFields, urn: string): Record<string, unknown> {
  const identifier: Array<Record<string, unknown>> = [
    {
      system: 'urn:digisparsh:hospital:mrn',
      value: p.hospitalMrn,
    },
  ];
  if (p.abhaId) {
    identifier.push({
      system: 'https://healthid.abdm.gov.in',
      value: p.abhaId,
    });
  }
  const nameParts = p.fullName.trim().split(/\s+/);
  const family = nameParts.length > 1 ? (nameParts[nameParts.length - 1] ?? '') : '';
  const given = nameParts.length > 1 ? nameParts.slice(0, -1) : nameParts;
  const resource: Record<string, unknown> = {
    resourceType: 'Patient',
    id: urn,
    meta: { profile: [PROFILE_PATIENT] },
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

function organizationResource(code: string, displayName: string | undefined): Record<string, unknown> {
  return {
    resourceType: 'Organization',
    id: `urn:digisparsh:org:${code}`,
    meta: { profile: [PROFILE_ORGANIZATION] },
    identifier: [{ system: SYS_NDHM_ORGANIZATION, value: code }],
    name: displayName ?? code,
  };
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
    meta: { profile: [PROFILE_COVERAGE] },
    status: 'active',
    subscriberId: c.memberId,
    beneficiary: { reference: patientUrn },
    payor: [{ reference: payerUrn }],
  };
  if (c.coverageTypeCode) {
    resource['type'] = {
      coding: [
        {
          system: SYS_NDHM_COVERAGE_TYPE,
          code: c.coverageTypeCode,
          ...(c.coverageTypeDisplay ? { display: c.coverageTypeDisplay } : {}),
        },
      ],
    };
  }
  if (c.periodStart || c.periodEnd) {
    resource['period'] = {
      ...(c.periodStart ? { start: c.periodStart } : {}),
      ...(c.periodEnd ? { end: c.periodEnd } : {}),
    };
  }
  return resource;
}

function practitionerResource(
  pr: FhirPractitionerFields,
  urn: string,
): Record<string, unknown> {
  const identifier: Array<Record<string, unknown>> = [];
  if (pr.hprId) {
    identifier.push({ system: SYS_HPR, value: pr.hprId });
  }
  if (pr.registrationNumber) {
    identifier.push({
      system: pr.registrationSystem ?? 'urn:digisparsh:doctor:registration',
      value: pr.registrationNumber,
    });
  }
  const nameParts = pr.fullName.trim().split(/\s+/);
  const family = nameParts.length > 1 ? (nameParts[nameParts.length - 1] ?? '') : '';
  const given = nameParts.length > 1 ? nameParts.slice(0, -1) : nameParts;
  const resource: Record<string, unknown> = {
    resourceType: 'Practitioner',
    id: urn,
    meta: { profile: [PROFILE_PRACTITIONER] },
    ...(identifier.length > 0 ? { identifier } : {}),
    name: [
      {
        text: pr.fullName,
        ...(family ? { family } : {}),
        ...(given.length > 0 ? { given } : {}),
      },
    ],
  };
  if (pr.qualification) {
    resource['qualification'] = [{ code: { text: pr.qualification } }];
  }
  return resource;
}

// ---- Public builders ----------------------------------------

export function buildEligibilityRequestBundle(input: FhirEligibilityRequestInput): FhirBundle {
  const uuid = input.uuid ?? randomUUID;
  const ts = (input.now ?? (() => new Date()))().toISOString();
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
    meta: { profile: [PROFILE_COVERAGE_ELIGIBILITY_REQUEST] },
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
      profile: [PROFILE_ELIGIBILITY_BUNDLE],
      security: META_SECURITY_V_RESTRICTED,
    },
    identifier: { value: bundleId },
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
  practitionerUrn: string | undefined,
  urn: string,
  ts: string,
  finalAmountPaise?: number,
  documentIds?: string[],
): Record<string, unknown> {
  const amount = finalAmountPaise ?? input.requestedAmount ?? 0;
  const claim: Record<string, unknown> = {
    resourceType: 'Claim',
    id: urn,
    meta: { profile: [PROFILE_CLAIM] },
    identifier: [
      {
        system: 'urn:digisparsh:claim:id',
        value: input.localClaimId,
      },
    ],
    status: 'active',
    // NRCES NHCX preauth examples carry SNOMED "Inpatient care
    // management" as Claim.type — not the HL7 v3 institutional code.
    // See `md/nrces.in/ndhm/fhir/r4/Bundle-ClaimBundle-preauthorization-example-01.json.md:55–61`.
    type: {
      coding: [
        {
          system: SYS_SNOMED,
          code: SNOMED_INPATIENT_CARE,
          display: 'Inpatient care management (procedure)',
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

  // Claim.billablePeriod — NRCES profile requires admission window
  // when available. We populate from `admissionStart`/`admissionEnd`
  // when callers provide them.
  if (input.admissionStart || input.admissionEnd) {
    claim['billablePeriod'] = {
      ...(input.admissionStart ? { start: input.admissionStart } : {}),
      ...(input.admissionEnd ? { end: input.admissionEnd } : {}),
    };
  }

  // Claim.careTeam — required by NRCES profile when a treating
  // doctor exists. We emit a single-entry team referencing the
  // Practitioner resource the bundle carries.
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

  if (input.diagnosisIcdCode || input.diagnosisSnomedCode || input.diagnosisDescription) {
    const codings: Array<Record<string, unknown>> = [];
    if (input.diagnosisIcdCode) {
      codings.push({
        system: SYS_ICD10,
        code: input.diagnosisIcdCode,
        ...(input.diagnosisDescription ? { display: input.diagnosisDescription } : {}),
      });
    }
    if (input.diagnosisSnomedCode) {
      codings.push({
        system: SYS_SNOMED,
        code: input.diagnosisSnomedCode,
        ...(input.diagnosisDescription ? { display: input.diagnosisDescription } : {}),
      });
    }
    claim['diagnosis'] = [
      {
        sequence: 1,
        diagnosisCodeableConcept: {
          ...(codings.length > 0 ? { coding: codings } : {}),
          ...(input.diagnosisDescription ? { text: input.diagnosisDescription } : {}),
        },
        // SNOMED "Final diagnosis (discharge)" per NRCES example
        // (Bundle-ClaimBundle-preauthorization-example-01.json:128–138).
        type: [
          {
            coding: [
              { system: SYS_SNOMED, code: SNOMED_DISCHARGE_DIAGNOSIS, display: 'Final diagnosis (discharge)' },
            ],
          },
        ],
      },
    ];
  }

  if (input.plannedProcedure || input.procedureCode || input.hbpPackageCode) {
    const procedureCodings: Array<Record<string, unknown>> = [];
    if (input.procedureCode) {
      procedureCodings.push({
        // SNOMED CT is the NRCES default; callers can override the
        // system explicitly via `procedureSystem` when emitting from
        // PMJAY HBP or other code lists.
        system: input.procedureSystem ?? SYS_SNOMED,
        code: input.procedureCode,
        ...(input.plannedProcedure ? { display: input.plannedProcedure } : {}),
      });
    }
    if (input.hbpPackageCode) {
      procedureCodings.push({
        system: SYS_NDHM_BILLING_CODES,
        code: input.hbpPackageCode,
        ...(input.plannedProcedure ? { display: input.plannedProcedure } : {}),
      });
    }
    claim['procedure'] = [
      {
        sequence: 1,
        procedureCodeableConcept: {
          ...(procedureCodings.length > 0 ? { coding: procedureCodings } : {}),
          ...(input.plannedProcedure ? { text: input.plannedProcedure } : {}),
        },
      },
    ];
  }

  // Claim.item[] line-level pricing. NRCES preauth example carries
  // an item array with productOrService + unitPrice + net per line;
  // the settlement variant extends each item with adjudication. We
  // emit the request side here.
  if (input.lineItems && input.lineItems.length > 0) {
    claim['item'] = input.lineItems.map((li, idx) => {
      const sequence = li.sequence ?? idx + 1;
      const quantity = li.quantity ?? 1;
      const unitRupees = li.unitPricePaise / 100;
      const netRupees = (li.netPricePaise ?? li.unitPricePaise * quantity) / 100;
      return {
        sequence,
        productOrService: {
          coding: [
            {
              system: li.codeSystem ?? SYS_NDHM_BILLING_CODES,
              code: li.code,
              ...(li.display ? { display: li.display } : {}),
            },
          ],
          ...(li.display ? { text: li.display } : {}),
        },
        ...(li.servicedDate ? { servicedDate: li.servicedDate } : {}),
        ...(quantity !== 1 ? { quantity: { value: quantity } } : {}),
        unitPrice: { value: unitRupees, currency: 'INR' },
        net: { value: netRupees, currency: 'INR' },
      };
    });
  }

  // supportingInfo — now system-coded per NRCES
  // `ndhm-supportinginfo-category` rather than the bare-code form.
  const supportingInfo: Array<Record<string, unknown>> = [];
  if (input.estimatedLengthOfStayDays && input.estimatedLengthOfStayDays > 0) {
    supportingInfo.push({
      sequence: 1,
      category: {
        coding: [
          {
            system: SYS_NDHM_SUPPORTINGINFO_CATEGORY,
            code: 'hospitalized',
            display: 'Hospitalization',
          },
        ],
      },
      // SNOMED hospitalisation code as the value coding per IG
      // examples; quantity stays as days for backwards compat.
      valueQuantity: { value: input.estimatedLengthOfStayDays, unit: 'days' },
      code: { coding: [{ system: SYS_SNOMED, code: SNOMED_HOSPITALISATION, display: 'Hospital admission' }] },
    });
  }
  if (documentIds && documentIds.length > 0) {
    documentIds.forEach((docId, idx) => {
      supportingInfo.push({
        sequence: idx + 100,
        category: {
          coding: [
            {
              system: SYS_NDHM_SUPPORTINGINFO_CATEGORY,
              code: 'attachment',
              display: 'Document attachment',
            },
          ],
        },
        valueReference: { reference: `Binary/${docId}` },
      });
    });
  }
  if (supportingInfo.length > 0) {
    claim['supportingInfo'] = supportingInfo;
  }

  if (input.clinicalJustification) {
    claim['note'] = [{ text: input.clinicalJustification }];
  }
  return claim;
}

export function buildPreauthSubmitBundle(input: FhirPreauthSubmitInput): FhirBundle {
  const uuid = input.uuid ?? randomUUID;
  const ts = (input.now ?? (() => new Date()))().toISOString();
  const URN = makeUrn(uuid);
  const bundleId = uuid();
  const patientUrn = URN('patient');
  const insurerUrn = URN('insurer');
  const providerUrn = URN('provider');
  const coverageUrn = URN('coverage');
  const claimUrn = URN('claim');
  const practitionerUrn = input.practitioner ? URN('practitioner') : undefined;

  const entries: BundleEntry[] = [
    {
      fullUrl: claimUrn,
      resource: claimResource(
        input,
        'preauthorization',
        patientUrn,
        insurerUrn,
        providerUrn,
        coverageUrn,
        practitionerUrn,
        claimUrn,
        ts,
      ),
    },
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
  ];
  if (practitionerUrn && input.practitioner) {
    entries.push({
      fullUrl: practitionerUrn,
      resource: practitionerResource(input.practitioner, practitionerUrn),
    });
  }

  return {
    resourceType: 'Bundle',
    id: bundleId,
    meta: {
      lastUpdated: ts,
      profile: [PROFILE_CLAIM_BUNDLE],
      security: META_SECURITY_V_RESTRICTED,
    },
    identifier: { value: bundleId },
    type: 'collection',
    timestamp: ts,
    entry: entries,
  };
}

export function buildClaimSubmitBundle(input: FhirClaimSubmitInput): FhirBundle {
  const bundle = buildPreauthSubmitBundle(input);
  // Replace the Claim entry with the use='claim' variant + finalAmount
  // + documentIds wired into supportingInfo. Same NRCES ClaimBundle
  // profile is used; the only delta is `Claim.use` ('claim' vs
  // 'preauthorization') and the final amount.
  const patientUrn = (bundle.entry.find((e) => e.resource['resourceType'] === 'Patient')?.fullUrl ?? '') as string;
  const insurerUrn = (bundle.entry.find((e) => e.resource['resourceType'] === 'Organization' && (e.resource['identifier'] as Array<{ value: string }>)[0]?.value === input.coverage.payerCode)?.fullUrl ?? '') as string;
  const providerUrn = (bundle.entry.find((e) => e.resource['resourceType'] === 'Organization' && (e.resource['identifier'] as Array<{ value: string }>)[0]?.value === input.actors.senderCode)?.fullUrl ?? '') as string;
  const coverageUrn = (bundle.entry.find((e) => e.resource['resourceType'] === 'Coverage')?.fullUrl ?? '') as string;
  const practitionerEntry = bundle.entry.find((e) => e.resource['resourceType'] === 'Practitioner');
  const practitionerUrn = practitionerEntry?.fullUrl;
  const claimEntryIdx = bundle.entry.findIndex((e) => e.resource['resourceType'] === 'Claim');
  const claimUrn = bundle.entry[claimEntryIdx]?.fullUrl ?? makeUrn(input.uuid ?? randomUUID)('claim');

  bundle.entry[claimEntryIdx] = {
    fullUrl: claimUrn,
    resource: claimResource(
      input,
      'claim',
      patientUrn,
      insurerUrn,
      providerUrn,
      coverageUrn,
      practitionerUrn,
      claimUrn,
      bundle.timestamp,
      input.finalAmount,
      input.documentIds,
    ),
  };
  return bundle;
}

export function buildCommunicationBundle(input: FhirCommunicationInput): FhirBundle {
  const uuid = input.uuid ?? randomUUID;
  const ts = (input.now ?? (() => new Date()))().toISOString();
  const URN = makeUrn(uuid);
  const bundleId = uuid();
  const senderUrn = URN('sender');
  const recipientUrn = URN('recipient');
  const communicationUrn = URN('communication');

  const communication: Record<string, unknown> = {
    resourceType: 'Communication',
    id: communicationUrn,
    meta: { profile: [PROFILE_COMMUNICATION] },
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
      profile: [PROFILE_COMMUNICATION_BUNDLE],
      security: META_SECURITY_V_RESTRICTED,
    },
    identifier: { value: bundleId },
    type: 'collection',
    timestamp: ts,
    entry: [
      { fullUrl: communicationUrn, resource: communication },
      { fullUrl: senderUrn, resource: organizationResource(input.actors.senderCode, undefined) },
      { fullUrl: recipientUrn, resource: organizationResource(input.actors.receiverCode, undefined) },
    ],
  };
}

// `insuranceplan/request` TaskBundle. Mirrors the NRCES example
// (Bundle-TaskBundleForInsurancePlanRequest-example-01.json):
// `Task.status = 'completed'`, `Task.code` is HL7 `financialtaskcode/poll`
// (not the NDHM task-codes system — that one is reserved for cancel /
// reprocess flows). The two inputs ride on the NDHM
// `ndhm-task-input-type-code` system.
export function buildInsurancePlanRequestBundle(
  input: FhirInsurancePlanRequestInput,
): FhirBundle {
  const uuid = input.uuid ?? randomUUID;
  const ts = (input.now ?? (() => new Date()))().toISOString();
  const URN = makeUrn(uuid);
  const bundleId = uuid();
  const senderUrn = URN('sender');
  const recipientUrn = URN('recipient');
  const taskUrn = URN('task');

  const task: Record<string, unknown> = {
    resourceType: 'Task',
    id: taskUrn,
    meta: { profile: [PROFILE_TASK] },
    status: 'completed',
    intent: 'order',
    code: {
      coding: [
        { system: SYS_FINANCIAL_TASK_CODE, code: 'poll', display: 'Poll' },
      ],
    },
    description: 'Give the details of Insurance plan linked with the given policy number',
    authoredOn: ts,
    requester: { reference: senderUrn },
    owner: { reference: recipientUrn },
    input: [
      {
        type: {
          coding: [
            {
              system: SYS_NDHM_TASK_INPUT_TYPE,
              code: 'policyNumber',
              display: 'PolicyNumber',
            },
          ],
        },
        valueString: input.policyNumber,
      },
      {
        type: {
          coding: [
            {
              system: SYS_NDHM_TASK_INPUT_TYPE,
              code: 'providerId',
              display: 'ProviderId',
            },
          ],
        },
        valueString: input.providerId,
      },
    ],
  };

  return {
    resourceType: 'Bundle',
    id: bundleId,
    meta: {
      lastUpdated: ts,
      profile: [PROFILE_TASK_BUNDLE],
      security: META_SECURITY_V_RESTRICTED,
    },
    identifier: { value: bundleId },
    type: 'collection',
    timestamp: ts,
    entry: [
      { fullUrl: taskUrn, resource: task },
      {
        fullUrl: senderUrn,
        resource: organizationResource(input.actors.senderCode, input.hospitalDisplayName),
      },
      {
        fullUrl: recipientUrn,
        resource: organizationResource(input.actors.receiverCode, input.payerDisplayName),
      },
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
  const ts = (input.now ?? (() => new Date()))().toISOString();
  const URN = makeUrn(uuid);
  const bundleId = uuid();
  const senderUrn = URN('sender');
  const recipientUrn = URN('recipient');
  const taskUrn = URN('task');

  // Dual-coded: NRCES canonical first (so NHCX/NHA validators pass),
  // then the PMJAY-specific URI second (so PMJAY's payer-side adapter
  // can continue to pick up the coding it already knows). NRCES IG
  // allows multiple `coding` entries on a single CodeableConcept.
  const task: Record<string, unknown> = {
    resourceType: 'Task',
    id: taskUrn,
    meta: { profile: [PROFILE_TASK] },
    status: 'cancelled',
    intent: 'order',
    authoredOn: ts,
    requester: { reference: senderUrn },
    owner: { reference: recipientUrn },
    code: {
      coding: [
        {
          system: SYS_NDHM_TASK_CODES,
          code: 'cancel',
          display: 'Cancel preauthorization',
        },
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
              system: SYS_NDHM_TASK_INPUT_TYPE,
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
      profile: [PROFILE_TASK_BUNDLE],
      security: META_SECURITY_V_RESTRICTED,
    },
    identifier: { value: bundleId },
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
  const ts = (input.now ?? (() => new Date()))().toISOString();
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
    meta: { profile: [PROFILE_TASK] },
    status: 'requested',
    intent: 'order',
    authoredOn: ts,
    requester: { reference: senderUrn },
    owner: { reference: recipientUrn },
    code: {
      coding: [
        {
          system: SYS_NDHM_TASK_CODES,
          code: 'reprocess',
          display: 'Reprocess claim',
        },
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
              system: SYS_NDHM_TASK_INPUT_TYPE,
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
              system: SYS_NDHM_REASON_CODE,
              code: 'ReasonCode',
              display: 'Reprocess reason',
            },
            {
              system: PMJAY_TASK_REASON_SYSTEM,
              code: 'ReasonCode',
              display: 'Reprocess reason',
            },
          ],
        },
        valueCoding: {
          system: SYS_NDHM_REASON_CODE,
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
      profile: [PROFILE_TASK_BUNDLE],
      security: META_SECURITY_V_RESTRICTED,
    },
    identifier: { value: bundleId },
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
