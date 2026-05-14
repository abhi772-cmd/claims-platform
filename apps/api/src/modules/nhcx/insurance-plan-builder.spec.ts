// Targeted assertions for buildInsurancePlanRequestBundle. The
// snapshot test in fhir-builders.snapshot.spec.ts locks the whole
// shape; these tests pin the load-bearing parts so a careless edit
// fails with a readable message instead of a 200-line diff.

import { buildInsurancePlanRequestBundle } from './fhir-builders';

const actors = { senderCode: 'sender@hcx', receiverCode: 'payer@hcx' };

describe('buildInsurancePlanRequestBundle (GAP_ANALYSIS row 1.13)', () => {
  it('stamps TaskBundle profile + meta.security on the Bundle', () => {
    const bundle = buildInsurancePlanRequestBundle({
      actors,
      policyNumber: 'POL-1',
      providerId: '12345',
    });
    expect(bundle.meta.profile).toEqual([
      'https://nrces.in/ndhm/fhir/r4/StructureDefinition/TaskBundle',
    ]);
    expect(bundle.meta.security?.[0]?.code).toBe('V');
  });

  it('Task carries the financialtaskcode/poll coding', () => {
    const bundle = buildInsurancePlanRequestBundle({
      actors,
      policyNumber: 'POL-1',
      providerId: '12345',
    });
    const task = bundle.entry.find((e) => e.resource['resourceType'] === 'Task')
      ?.resource as Record<string, unknown> | undefined;
    expect(task).toBeDefined();
    expect(task!['status']).toBe('completed');
    expect(task!['intent']).toBe('order');
    const code = task!['code'] as { coding: Array<{ system: string; code: string }> };
    expect(code.coding[0]).toEqual({
      system: 'http://terminology.hl7.org/CodeSystem/financialtaskcode',
      code: 'poll',
      display: 'Poll',
    });
  });

  it('Task.input carries policyNumber + providerId on the NDHM system', () => {
    const bundle = buildInsurancePlanRequestBundle({
      actors,
      policyNumber: 'POL-ABC-1',
      providerId: 'HFR-9999',
    });
    const task = bundle.entry.find((e) => e.resource['resourceType'] === 'Task')
      ?.resource as Record<string, unknown> | undefined;
    const input = task!['input'] as Array<{
      type: { coding: Array<{ system: string; code: string }> };
      valueString: string;
    }>;
    expect(input).toHaveLength(2);
    expect(input[0]?.type.coding[0]?.system).toBe(
      'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-task-input-type-code',
    );
    expect(input[0]?.type.coding[0]?.code).toBe('policyNumber');
    expect(input[0]?.valueString).toBe('POL-ABC-1');
    expect(input[1]?.type.coding[0]?.code).toBe('providerId');
    expect(input[1]?.valueString).toBe('HFR-9999');
  });

  it('emits requester + owner Organizations referencing sender + receiver codes', () => {
    const bundle = buildInsurancePlanRequestBundle({
      actors,
      policyNumber: 'POL-1',
      providerId: '12345',
      payerDisplayName: 'Star Health',
      hospitalDisplayName: 'Asha Hospital',
    });
    // Three entries: Task + sender Org + recipient Org
    expect(bundle.entry).toHaveLength(3);
    const orgs = bundle.entry
      .filter((e) => e.resource['resourceType'] === 'Organization')
      .map((e) => e.resource as Record<string, unknown>);
    expect(orgs).toHaveLength(2);
    const names = orgs.map((o) => o['name']);
    expect(names).toContain('Star Health');
    expect(names).toContain('Asha Hospital');
    // Identifiers use the NDHM organization system
    const orgIdSystems = orgs.flatMap((o) =>
      (o['identifier'] as Array<{ system: string }>).map((i) => i.system),
    );
    expect(orgIdSystems).toContain('https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-organization');
  });

  it('Bundle.identifier carries a bare value (no ig.hcxprotocol.io system)', () => {
    const bundle = buildInsurancePlanRequestBundle({
      actors,
      policyNumber: 'POL-1',
      providerId: '12345',
    });
    expect(bundle.identifier).toBeDefined();
    expect(bundle.identifier?.value).toMatch(/^[0-9a-f-]{36}$/);
    expect(bundle.identifier?.system).toBeUndefined();
  });
});
