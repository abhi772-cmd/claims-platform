import {
  buildClaimSubmitBundle,
  buildCommunicationBundle,
  buildEligibilityRequestBundle,
  buildPreauthSubmitBundle,
} from './fhir-builders';

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

describe('FHIR R4 bundle builders', () => {
  describe('buildEligibilityRequestBundle', () => {
    const bundle = buildEligibilityRequestBundle({
      actors,
      patient,
      coverage,
      serviceDate: '2026-05-01',
    });

    it('returns a Bundle with type=collection and 5 entries', () => {
      expect(bundle.resourceType).toBe('Bundle');
      expect(bundle.type).toBe('collection');
      expect(bundle.entry).toHaveLength(5);
    });

    it('contains the four expected resources alongside the request', () => {
      const types = bundle.entry.map((e) => e.resource['resourceType']).sort();
      expect(types).toEqual(['Coverage', 'CoverageEligibilityRequest', 'Organization', 'Organization', 'Patient']);
    });

    it('CoverageEligibilityRequest has servicedDate + insurance.coverage ref', () => {
      const req = bundle.entry.find(
        (e) => e.resource['resourceType'] === 'CoverageEligibilityRequest',
      )?.resource as Record<string, unknown> | undefined;
      expect(req).toBeDefined();
      expect(req!['servicedDate']).toBe('2026-05-01');
      const insurance = req!['insurance'] as Array<{ coverage: { reference: string } }>;
      expect(insurance[0]?.coverage.reference).toMatch(/^urn:uuid:[0-9a-f-]+-coverage$/);
    });

    it('Patient resource carries the hospital MRN identifier', () => {
      const p = bundle.entry.find((e) => e.resource['resourceType'] === 'Patient')
        ?.resource as Record<string, unknown> | undefined;
      const ids = p!['identifier'] as Array<{ system: string; value: string }>;
      const mrn = ids.find((i) => i.system === 'urn:digisparsh:hospital:mrn');
      expect(mrn?.value).toBe('MRN-001');
      const abha = ids.find((i) => i.system === 'https://healthid.abdm.gov.in');
      expect(abha?.value).toBe('12-3456-7890-1234');
    });

    it('Coverage links beneficiary → patient and payor → insurer', () => {
      const cov = bundle.entry.find((e) => e.resource['resourceType'] === 'Coverage')
        ?.resource as Record<string, unknown> | undefined;
      expect(cov!['subscriberId']).toBe('POL-001');
      const patientUrn = (cov!['beneficiary'] as { reference: string }).reference;
      expect(patientUrn).toMatch(/-patient$/);
    });
  });

  describe('buildPreauthSubmitBundle', () => {
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
      requestedAmount: 25000000, // 250000 INR in paise
      clinicalJustification: 'Patient symptomatic; surgical intervention indicated.',
    });

    it('contains a Claim with use=preauthorization and INR total', () => {
      const claim = bundle.entry.find((e) => e.resource['resourceType'] === 'Claim')
        ?.resource as Record<string, unknown> | undefined;
      expect(claim).toBeDefined();
      expect(claim!['use']).toBe('preauthorization');
      const total = claim!['total'] as { value: number; currency: string };
      expect(total.currency).toBe('INR');
      expect(total.value).toBe(250000); // paise → rupees
    });

    it('includes diagnosis with ICD-10 coding and procedure with hospital procedure code', () => {
      const claim = bundle.entry.find((e) => e.resource['resourceType'] === 'Claim')
        ?.resource as Record<string, unknown> | undefined;
      const diagnosis = (claim!['diagnosis'] as Array<{
        diagnosisCodeableConcept: { coding: Array<{ system: string; code: string }> };
      }>)[0];
      expect(diagnosis?.diagnosisCodeableConcept.coding[0]).toEqual(
        expect.objectContaining({ system: 'http://hl7.org/fhir/sid/icd-10', code: 'I10' }),
      );
      const proc = (claim!['procedure'] as Array<{
        procedureCodeableConcept: { coding: Array<{ code: string }> };
      }>)[0];
      expect(proc?.procedureCodeableConcept.coding[0]?.code).toBe('PROC-001');
    });

    it('echoes localClaimId as a Claim.identifier', () => {
      const claim = bundle.entry.find((e) => e.resource['resourceType'] === 'Claim')
        ?.resource as Record<string, unknown> | undefined;
      const ids = claim!['identifier'] as Array<{ system: string; value: string }>;
      expect(ids[0]).toEqual(
        expect.objectContaining({ system: 'urn:digisparsh:claim:id', value: 'claim-1' }),
      );
    });
  });

  describe('buildClaimSubmitBundle', () => {
    const bundle = buildClaimSubmitBundle({
      actors,
      patient,
      coverage,
      localClaimId: 'claim-2',
      finalAmount: 32000000,
      documentIds: ['doc-1', 'doc-2'],
      diagnosisIcdCode: 'I21.9',
    });

    it('uses use=claim with the final amount', () => {
      const claim = bundle.entry.find((e) => e.resource['resourceType'] === 'Claim')
        ?.resource as Record<string, unknown> | undefined;
      expect(claim!['use']).toBe('claim');
      expect((claim!['total'] as { value: number }).value).toBe(320000);
    });

    it('attaches documentIds as supportingInfo references', () => {
      const claim = bundle.entry.find((e) => e.resource['resourceType'] === 'Claim')
        ?.resource as Record<string, unknown> | undefined;
      const supporting = claim!['supportingInfo'] as Array<{
        valueReference?: { reference: string };
      }>;
      const refs = supporting
        .map((s) => s.valueReference?.reference)
        .filter((r): r is string => Boolean(r));
      expect(refs).toEqual(['Binary/doc-1', 'Binary/doc-2']);
    });
  });

  describe('buildCommunicationBundle', () => {
    it('contains a Communication with payload + actor refs', () => {
      const bundle = buildCommunicationBundle({
        actors,
        payload: 'Patient was admitted on 2026-05-01.',
        inReplyToRefNum: 'PA-12345',
      });
      expect(bundle.entry).toHaveLength(3);
      const comm = bundle.entry.find((e) => e.resource['resourceType'] === 'Communication')
        ?.resource as Record<string, unknown> | undefined;
      expect((comm!['payload'] as Array<{ contentString: string }>)[0]?.contentString).toBe(
        'Patient was admitted on 2026-05-01.',
      );
      const inResponseTo = comm!['inResponseTo'] as Array<{ identifier: { value: string } }>;
      expect(inResponseTo[0]?.identifier.value).toBe('PA-12345');
    });
  });
});
