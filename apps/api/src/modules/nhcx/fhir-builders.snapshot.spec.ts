import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildClaimSubmitBundle,
  buildCommunicationBundle,
  buildEligibilityRequestBundle,
  buildPreauthSubmitBundle,
  type FhirBundle,
} from './fhir-builders';

// Slice Y: snapshot lock for the four FHIR R4 builders.
//
// We build each bundle with deterministic uuid + clock factories and
// compare the output against a committed pretty-printed JSON file in
// `reference/fhir-bundles/`. Any unintended shape change in a builder
// fails the assertion with a readable diff. To intentionally update
// the locked shape, run with UPDATE_FIXTURES=1 and review the diff
// in the PR.

const FIXTURE_DIR = join(__dirname, '..', '..', '..', '..', '..', 'reference', 'fhir-bundles');

function makeDeterministicUuid(): () => string {
  let n = 0;
  return () => {
    n += 1;
    const hex = n.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${hex}`;
  };
}

const FIXED_NOW = (): Date => new Date('2026-05-01T10:00:00.000Z');

const actors = { senderCode: 'SENDER1', receiverCode: 'RECEIVER1' };
const patient = {
  fullName: 'Asha Devi',
  hospitalMrn: 'MRN-001',
  dateOfBirth: '1990-04-12',
  gender: 'female' as const,
  abhaId: '12-3456-7890-1234',
};
const coverage = {
  payerCode: 'MEDIASSIST',
  payerDisplayName: 'Medi Assist',
  memberId: 'POL-001',
};

function assertOrUpdate(name: string, bundle: FhirBundle): void {
  const path = join(FIXTURE_DIR, `${name}.json`);
  const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
  if (process.env['UPDATE_FIXTURES'] === '1' || !existsSync(path)) {
    writeFileSync(path, serialized, 'utf8');
    return;
  }
  const expected = readFileSync(path, 'utf8');
  expect(serialized).toEqual(expected);
}

describe('FHIR R4 bundle builders — locked shape', () => {
  it('eligibility-request bundle matches reference', () => {
    const bundle = buildEligibilityRequestBundle({
      actors,
      patient,
      coverage,
      serviceDate: '2026-05-01',
      uuid: makeDeterministicUuid(),
      now: FIXED_NOW,
    });
    assertOrUpdate('eligibility-request', bundle);
  });

  it('preauth-submit bundle matches reference', () => {
    const bundle = buildPreauthSubmitBundle({
      actors,
      patient,
      coverage,
      localClaimId: 'claim-1',
      diagnosisIcdCode: 'I10',
      diagnosisDescription: 'Essential hypertension',
      plannedProcedure: 'CABG',
      procedureCode: 'PROC-001',
      estimatedLengthOfStayDays: 3,
      requestedAmount: 25000000,
      clinicalJustification: 'Patient symptomatic; surgical intervention indicated.',
      uuid: makeDeterministicUuid(),
      now: FIXED_NOW,
    });
    assertOrUpdate('preauth-submit', bundle);
  });

  it('claim-submit bundle matches reference', () => {
    const bundle = buildClaimSubmitBundle({
      actors,
      patient,
      coverage,
      localClaimId: 'claim-2',
      finalAmount: 32000000,
      documentIds: ['doc-1', 'doc-2'],
      diagnosisIcdCode: 'I21.9',
      uuid: makeDeterministicUuid(),
      now: FIXED_NOW,
    });
    assertOrUpdate('claim-submit', bundle);
  });

  it('communication bundle matches reference', () => {
    const bundle = buildCommunicationBundle({
      actors,
      payload: 'Patient was admitted on 2026-05-01.',
      inReplyToRefNum: 'PA-12345',
      uuid: makeDeterministicUuid(),
      now: FIXED_NOW,
    });
    assertOrUpdate('communication', bundle);
  });
});
