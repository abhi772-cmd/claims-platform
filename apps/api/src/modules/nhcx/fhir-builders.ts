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
}

export interface FhirEligibilityRequestInput extends FhirDeterminismDeps {
  actors: FhirActorIds;
  patient: FhirPatientFields;
  coverage: FhirCoverageFields;
  serviceDate: string; // YYYY-MM-DD
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

const HCX_PROFILE_ELIGIBILITY = 'https://ig.hcxprotocol.io/v0.7.1/StructureDefinition-CoverageEligibilityRequestBundle.html';
const HCX_PROFILE_PREAUTH = 'https://ig.hcxprotocol.io/v0.7.1/StructureDefinition-ClaimRequestBundle.html';
const HCX_PROFILE_CLAIM = 'https://ig.hcxprotocol.io/v0.7.1/StructureDefinition-ClaimRequestBundle.html';
const HCX_PROFILE_COMMUNICATION = 'https://ig.hcxprotocol.io/v0.7.1/StructureDefinition-CommunicationBundle.html';

const DEFAULT_BUNDLE_SYSTEM = 'https://ig.hcxprotocol.io';

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
    identifier: [{ system: 'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-organization', value: code }],
    name: displayName ?? code,
  };
}

function coverageResource(
  c: FhirCoverageFields,
  patientUrn: string,
  payerUrn: string,
  urn: string,
): Record<string, unknown> {
  return {
    resourceType: 'Coverage',
    id: urn,
    status: 'active',
    subscriberId: c.memberId,
    beneficiary: { reference: patientUrn },
    payor: [{ reference: payerUrn }],
  };
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

  const eligibilityRequest: Record<string, unknown> = {
    resourceType: 'CoverageEligibilityRequest',
    id: requestUrn,
    status: 'active',
    purpose: ['benefits', 'validation'],
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
      profile: [HCX_PROFILE_ELIGIBILITY],
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
    type: {
      coding: [
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
  if (input.estimatedLengthOfStayDays && input.estimatedLengthOfStayDays > 0) {
    claim['supportingInfo'] = [
      {
        sequence: 1,
        category: { coding: [{ code: 'hospitalized' }] },
        valueQuantity: { value: input.estimatedLengthOfStayDays, unit: 'days' },
      },
    ];
  }
  if (input.clinicalJustification) {
    claim['note'] = [{ text: input.clinicalJustification }];
  }
  if (documentIds && documentIds.length > 0) {
    claim['supportingInfo'] = [
      ...(Array.isArray(claim['supportingInfo']) ? (claim['supportingInfo'] as unknown[]) : []),
      ...documentIds.map((docId, idx) => ({
        sequence: idx + 100,
        category: { coding: [{ code: 'attachment' }] },
        valueReference: { reference: `Binary/${docId}` },
      })),
    ];
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

  return {
    resourceType: 'Bundle',
    id: bundleId,
    meta: {
      lastUpdated: ts,
      profile: [HCX_PROFILE_PREAUTH],
    },
    identifier: { system: DEFAULT_BUNDLE_SYSTEM, value: bundleId },
    type: 'collection',
    timestamp: ts,
    entry: [
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
    ],
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
    ),
  };
  bundle.meta.profile = [HCX_PROFILE_CLAIM];
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
      profile: [HCX_PROFILE_COMMUNICATION],
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

export type { FhirBundle };
