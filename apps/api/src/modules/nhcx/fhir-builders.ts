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
}

export interface FhirCoverageFields {
  // Insurer / TPA / SHA on the payer side.
  payerCode: string;
  payerDisplayName?: string;
  // Member id on the policy. May be the policy number for private
  // rails, the PMJAY beneficiary id for the gov rail.
  memberId: string;
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
  const ts = nhcxIstIso((input.now ?? (() => new Date()))());
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
      profile: [NRCES_PROFILE_PREAUTH],
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
