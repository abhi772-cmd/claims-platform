// P1 bundle-correctness regression suite. Covers the new optional
// fields wired into the builders: patient identifiers, Practitioner,
// Organization NPI/NIIP/HFR, Coverage.period/policyHolder/type, Claim
// SNOMED + careTeam, supportingInfo split, EDT/ADDD/DTH date codes.

import {
  buildClaimSubmitBundle,
  buildEligibilityRequestBundle,
  buildPreauthSubmitBundle,
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

describe('P1.8 patient identifiers', () => {
  it('emits PMJAY identifier with the correct system URI and type coding', () => {
    const bundle = buildEligibilityRequestBundle({
      actors,
      patient: { ...patient, pmjayBeneficiaryId: 'PMJAY-12345' },
      coverage,
      serviceDate: '2026-05-01',
    });
    const p = findResource(bundle, 'Patient') as { identifier: Array<Record<string, unknown>> };
    const pmjay = p.identifier.find((i) => (i.system as string) === 'https://pmjay.gov.in/beneficiary');
    expect(pmjay).toBeDefined();
    expect(pmjay!.value).toBe('PMJAY-12345');
    const type = pmjay!.type as { coding: Array<{ code: string }> };
    expect(type.coding[0]?.code).toBe('PMJAY');
  });

  it('emits JHN / PI / Aadhaar identifiers with their canonical NRCeS systems', () => {
    const bundle = buildEligibilityRequestBundle({
      actors,
      patient: {
        ...patient,
        jhn: 'JHN-99',
        personalIdentifier: 'PI-77',
        aadhaar: '1234-5678-9012',
      },
      coverage,
      serviceDate: '2026-05-01',
    });
    const p = findResource(bundle, 'Patient') as { identifier: Array<{ system: string; value: string }> };
    expect(p.identifier.find((i) => i.value === 'JHN-99')?.system).toBe(
      'https://hcx.pmjay.nha.gov.in/jhn',
    );
    expect(p.identifier.find((i) => i.value === 'PI-77')?.system).toBe(
      'urn:nrces:fhir:r4:CodeSystem:personal-identifier',
    );
    expect(p.identifier.find((i) => i.value === '1234-5678-9012')?.system).toBe(
      'https://uidai.gov.in',
    );
  });

  it('omits PMJAY identifiers entirely when not supplied (back-compat)', () => {
    const bundle = buildEligibilityRequestBundle({
      actors,
      patient,
      coverage,
      serviceDate: '2026-05-01',
    });
    const p = findResource(bundle, 'Patient') as { identifier: Array<{ system: string }> };
    // Only the MRN entry survives.
    expect(p.identifier).toHaveLength(1);
    expect(p.identifier[0]!.system).toBe('urn:digisparsh:hospital:mrn');
  });
});

describe('P1.9 Practitioner with HPIN', () => {
  it('mints a Practitioner resource + careTeam reference when input.practitioner supplied', () => {
    const bundle = buildPreauthSubmitBundle({
      actors,
      patient,
      coverage,
      localClaimId: 'cl-1',
      practitioner: {
        fullName: 'Dr R Kumar',
        hpin: '12345678901234',
        qualification: 'MD',
      },
    });
    const pr = findResource(bundle, 'Practitioner') as
      | { identifier: Array<{ system: string; value: string }>; name: Array<{ text: string }> }
      | undefined;
    expect(pr).toBeDefined();
    expect(pr!.identifier[0]?.system).toBe('https://hpr.abdm.gov.in/hpid');
    expect(pr!.identifier[0]?.value).toBe('12345678901234');
    expect(pr!.name[0]?.text).toBe('Dr R Kumar');

    const claim = findResource(bundle, 'Claim') as { careTeam: Array<{ provider: { reference: string } }> };
    expect(claim.careTeam[0]?.provider.reference).toMatch(/practitioner/);
  });

  it('omits Practitioner + careTeam when not supplied (back-compat)', () => {
    const bundle = buildPreauthSubmitBundle({
      actors,
      patient,
      coverage,
      localClaimId: 'cl-1',
    });
    expect(findResource(bundle, 'Practitioner')).toBeUndefined();
    const claim = findResource(bundle, 'Claim') as Record<string, unknown>;
    expect(claim['careTeam']).toBeUndefined();
  });
});

describe('P1.10 Organization NPI / NIIP / HFR identifiers', () => {
  it('emits HFR / NPI / NIIP on the provider Organization when supplied', () => {
    const bundle = buildPreauthSubmitBundle({
      actors,
      patient,
      coverage,
      localClaimId: 'cl-1',
      providerIdentifiers: {
        hfrFacilityId: 'HFR-1234567890',
        npi: 'NPI-001',
        niip: 'NIIP-001',
      },
    });
    const orgs = bundle.entry.filter((e) => e.resource['resourceType'] === 'Organization');
    const provider = orgs.find(
      (o) => (o.resource['identifier'] as Array<{ value: string }>)[0]?.value === 'SENDER1',
    )!.resource as { identifier: Array<{ system: string; value: string }> };
    const map = Object.fromEntries(provider.identifier.map((i) => [i.value, i.system]));
    expect(map['HFR-1234567890']).toBe('https://facility.abdm.gov.in');
    expect(map['NPI-001']).toBe('https://nha.gov.in/CodeSystem/npi');
    expect(map['NIIP-001']).toBe('https://niip.irdai.gov.in/participant');
  });
});

describe('P1.11 Coverage.policyHolder + period + type', () => {
  it('emits Coverage.type, .policyHolder, and .period when supplied', () => {
    const bundle = buildPreauthSubmitBundle({
      actors,
      patient,
      coverage: {
        ...coverage,
        coverageType: 'EHCPOL',
        policyHolderName: 'Ramesh Sharma',
        periodStart: '2026-04-01',
        periodEnd: '2027-03-31',
      },
      localClaimId: 'cl-1',
    });
    const c = findResource(bundle, 'Coverage') as {
      type: { coding: Array<{ code: string }> };
      policyHolder: { display: string };
      period: { start: string; end: string };
    };
    expect(c.type.coding[0]?.code).toBe('EHCPOL');
    expect(c.policyHolder.display).toBe('Ramesh Sharma');
    expect(c.period.start).toBe('2026-04-01');
    expect(c.period.end).toBe('2027-03-31');
  });
});

describe('P1.12 Claim.type SNOMED + careTeam', () => {
  it('emits SNOMED 737481003 as the first Claim.type coding', () => {
    const bundle = buildPreauthSubmitBundle({
      actors,
      patient,
      coverage,
      localClaimId: 'cl-1',
    });
    const claim = findResource(bundle, 'Claim') as {
      type: { coding: Array<{ system: string; code: string }> };
    };
    expect(claim.type.coding[0]).toEqual({
      system: 'http://snomed.info/sct',
      code: '737481003',
      display: 'Inpatient encounter',
    });
    expect(claim.type.coding[1]?.code).toBe('institutional');
  });
});

describe('P1.13 supportingInfo split structured vs attachment', () => {
  it('emits DIA / HDS / CD / INF as valueString entries with their NRCeS categories', () => {
    const bundle = buildPreauthSubmitBundle({
      actors,
      patient,
      coverage,
      localClaimId: 'cl-1',
      supportingInfo: [
        { category: 'DIA', text: 'Chest X-ray normal' },
        { category: 'HDS', text: 'Patient stable post-op' },
      ],
    });
    const claim = findResource(bundle, 'Claim') as {
      supportingInfo: Array<{
        category: { coding: Array<{ code: string; system: string }> };
        valueString?: string;
        valueAttachment?: unknown;
      }>;
    };
    const dia = claim.supportingInfo.find((s) => s.category.coding[0]?.code === 'DIA');
    expect(dia?.valueString).toBe('Chest X-ray normal');
    expect(dia?.category.coding[0]?.system).toBe(
      'https://nrces.in/ndhm/fhir/r4/CodeSystem/claim-supporting-info-category',
    );
  });

  it('emits POI as valueAttachment with contentType + size + hash guards', () => {
    const bundle = buildPreauthSubmitBundle({
      actors,
      patient,
      coverage,
      localClaimId: 'cl-1',
      supportingInfo: [
        {
          category: 'POI',
          documentId: 'aadhaar-front',
          contentType: 'image/jpeg',
          sizeBytes: 81920,
          sha256: 'abc123',
        },
      ],
    });
    const claim = findResource(bundle, 'Claim') as {
      supportingInfo: Array<{
        category: { coding: Array<{ code: string }> };
        valueAttachment?: { url: string; contentType?: string; size?: number; hash?: string };
      }>;
    };
    const poi = claim.supportingInfo.find((s) => s.category.coding[0]?.code === 'POI');
    expect(poi?.valueAttachment).toEqual({
      url: 'Binary/aadhaar-front',
      contentType: 'image/jpeg',
      size: 81920,
      hash: 'abc123',
    });
  });
});

describe('P1.14 Mandatory date codes EDT / ADDD / DTH', () => {
  it('emits EDT / ADDD / DTH entries under the NRCeS supporting-info-category system', () => {
    const bundle = buildPreauthSubmitBundle({
      actors,
      patient,
      coverage,
      localClaimId: 'cl-1',
      encounterDates: {
        edt: '2026-05-05',
        addd: '2026-05-04',
        dth: '2026-05-08',
      },
    });
    const claim = findResource(bundle, 'Claim') as {
      supportingInfo: Array<{
        category: { coding: Array<{ code: string }> };
        valueString: string;
      }>;
    };
    const byCode = Object.fromEntries(
      claim.supportingInfo.map((s) => [s.category.coding[0]?.code, s.valueString]),
    );
    expect(byCode['EDT']).toBe('2026-05-05');
    expect(byCode['ADDD']).toBe('2026-05-04');
    expect(byCode['DTH']).toBe('2026-05-08');
  });
});

describe('buildClaimSubmitBundle threads Practitioner through to use=claim', () => {
  it('preserves the Practitioner careTeam reference when promoting preauth → claim', () => {
    const bundle = buildClaimSubmitBundle({
      actors,
      patient,
      coverage,
      localClaimId: 'cl-2',
      finalAmount: 5_000_000,
      documentIds: ['final-bill'],
      practitioner: {
        fullName: 'Dr R Kumar',
        hpin: '12345678901234',
      },
    });
    expect(findResource(bundle, 'Practitioner')).toBeDefined();
    const claim = findResource(bundle, 'Claim') as {
      use: string;
      careTeam: Array<{ provider: { reference: string } }>;
    };
    expect(claim.use).toBe('claim');
    expect(claim.careTeam[0]?.provider.reference).toMatch(/practitioner/);
  });
});
