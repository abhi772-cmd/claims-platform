// P2 PMJAY semantics regression suite. Covers:
//   P2.15 — CE 'discovery' purpose
//   P2.18 — Task cancel reason-code enum + Task.basedOn intimationNumber
//           (typo 'initimationNumber' preserved verbatim in system URI)

import {
  buildEligibilityRequestBundle,
  buildTaskCancelBundle,
  type FhirBundle,
} from './fhir-builders';

const actors = { senderCode: 'SENDER1', receiverCode: 'RECEIVER1' };
const patient = {
  fullName: 'Asha Devi',
  hospitalMrn: 'MRN-001',
  dateOfBirth: '1990-04-12',
  gender: 'female' as const,
};
const coverage = {
  payerCode: 'PMJAY-RAJ',
  payerDisplayName: 'PMJAY Rajasthan',
  memberId: 'POL-001',
};

function findResource(bundle: FhirBundle, type: string): Record<string, unknown> | undefined {
  return bundle.entry.find((e) => e.resource['resourceType'] === type)?.resource;
}

describe('P2.15 CoverageEligibilityRequest purpose=discovery', () => {
  it('emits purpose=["discovery"] when caller selects the PMJAY discovery phase', () => {
    const bundle = buildEligibilityRequestBundle({
      actors,
      patient,
      coverage,
      serviceDate: '2026-05-01',
      purpose: 'discovery',
    });
    const req = findResource(bundle, 'CoverageEligibilityRequest') as {
      purpose: string[];
    };
    expect(req.purpose).toEqual(['discovery']);
  });

  it('falls back to ["benefits","validation"] when no purpose specified (legacy)', () => {
    const bundle = buildEligibilityRequestBundle({
      actors,
      patient,
      coverage,
      serviceDate: '2026-05-01',
    });
    const req = findResource(bundle, 'CoverageEligibilityRequest') as {
      purpose: string[];
    };
    expect(req.purpose).toEqual(['benefits', 'validation']);
  });
});

describe('P2.18 Task cancel reason-code + initimationNumber (typo preserved)', () => {
  it('emits a ReasonCode Task.input entry under the documented PMJAY system', () => {
    const bundle = buildTaskCancelBundle({
      actors,
      preauthRefNum: 'PA-12345',
      reasonCode: 'patient-deceased',
    });
    const task = findResource(bundle, 'Task') as {
      input: Array<{
        type: { coding: Array<{ code: string }> };
        valueCoding?: { system: string; code: string };
      }>;
    };
    const reasonEntry = task.input.find((i) =>
      i.type.coding.some((c) => c.code === 'ReasonCode'),
    );
    expect(reasonEntry).toBeDefined();
    expect(reasonEntry!.valueCoding?.code).toBe('patient-deceased');
    expect(reasonEntry!.valueCoding?.system).toBe(
      'https://payer.pmjay.nha.gov.in/CodeSystem/task-reason',
    );
  });

  it('preserves the typo "initimationNumber" verbatim in Task.basedOn system URI', () => {
    const bundle = buildTaskCancelBundle({
      actors,
      preauthRefNum: 'PA-12345',
      initimationNumber: 'INT-9999',
    });
    const task = findResource(bundle, 'Task') as {
      basedOn: Array<{ identifier: { system: string; value: string } }>;
    };
    expect(task.basedOn[0]?.identifier.system).toBe(
      'https://hcx.pmjay.nha.gov.in/initimationNumber',
    );
    expect(task.basedOn[0]?.identifier.value).toBe('INT-9999');
  });

  it('omits ReasonCode + basedOn entries when neither field is supplied', () => {
    const bundle = buildTaskCancelBundle({
      actors,
      preauthRefNum: 'PA-12345',
    });
    const task = findResource(bundle, 'Task') as {
      input: Array<{ type: { coding: Array<{ code: string }> } }>;
      basedOn?: unknown;
    };
    expect(task.basedOn).toBeUndefined();
    expect(task.input.find((i) => i.type.coding.some((c) => c.code === 'ReasonCode'))).toBeUndefined();
  });
});
