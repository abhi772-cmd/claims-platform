// Slice BM — pure FHIR-validator tests. Covers:
//   1. Standard NHCX bundles classify into universal + nhcx, no
//      unknowns.
//   2. PMJAY bundles (real shape from
//      `HIMS-PMJAY suppporting docs/FHIR_bundles_PMJAY_ext/`) classify
//      cleanly into universal + nhcx + pmjay.
//   3. PMJAY identifier-type code is detected and `usesPmjayIdentifierType`
//      flips true.
//   4. Unknown payer-specific systems land in `unknown`.
//   5. Unknown identifier-type codes (under the NDHM system) land in
//      `unknownIdentifierTypeCodes`.
//   6. summariseFindings returns null on the happy path, surfaces
//      misroute signal when PMJAY systems appear on a non-PMJAY tenant,
//      and lists unknown systems / codes.

import { summariseFindings, validateBundle } from './fhir-validator';

describe('Slice BM — FHIR validator', () => {
  it('standard NHCX bundle: universal + nhcx, no unknowns', () => {
    const bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [
        {
          resource: {
            resourceType: 'CoverageEligibilityRequest',
            identifier: [{ system: 'urn:digisparsh:claim:id', value: 'c-1' }],
          },
        },
        {
          resource: {
            resourceType: 'Patient',
            identifier: [
              { system: 'urn:digisparsh:hospital:mrn', value: 'MRN-1' },
              { system: 'https://healthid.abdm.gov.in', value: '12-3456-7890-1234' },
            ],
          },
        },
        {
          resource: {
            resourceType: 'Organization',
            identifier: [
              {
                type: {
                  coding: [
                    {
                      system: 'http://terminology.hl7.org/CodeSystem/v2-0203',
                      code: 'NPI',
                    },
                  ],
                },
                system: 'https://facility.abdm.gov.in',
                value: 'IN1910000151',
              },
            ],
          },
        },
      ],
    };
    const r = validateBundle(bundle);
    expect(r.classified.unknown).toEqual([]);
    expect(r.classified.universal).toContain(
      'http://terminology.hl7.org/CodeSystem/v2-0203',
    );
    expect(r.classified.nhcx).toContain('urn:digisparsh:hospital:mrn');
    expect(r.classified.nhcx).toContain('https://healthid.abdm.gov.in');
    expect(r.classified.nhcx).toContain('https://facility.abdm.gov.in');
    expect(r.classified.pmjay).toEqual([]);
    expect(r.unknownIdentifierTypeCodes).toEqual([]);
    expect(r.usesPmjayIdentifierType).toBe(false);
  });

  it('PMJAY bundle: universal + nhcx + pmjay all populated; PMJAY identifier-type detected', () => {
    // Mirrors the shape of
    // `coveragerequest_benefits.txt` from the PMJAY supporting docs.
    const bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      identifier: { system: 'https://payer.pmjay.nha.gov.in', value: 'VB26AA2600001' },
      entry: [
        {
          resource: {
            resourceType: 'CoverageEligibilityRequest',
            identifier: [
              {
                system: 'https://hcx.pmjay.gov.in/v1/coverageeligibility/check',
                value: 'PMJAY/HP/S/G',
              },
            ],
            purpose: ['benefits'],
            facility: {
              identifier: { system: 'https://nhcx.pmjay.gov.in', value: 'IN1910000151' },
            },
            item: [
              {
                productOrService: {
                  coding: [
                    {
                      system: 'https://payer.pmjay.nha.gov.in',
                      code: 'MG004A',
                      display: 'Dengue fever',
                    },
                  ],
                },
                diagnosis: [
                  {
                    diagnosisCodeableConcept: {
                      coding: [
                        {
                          system: 'https://payer.pmjay.nha.gov.in',
                          code: 'A97.0',
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
        {
          resource: {
            resourceType: 'Patient',
            identifier: [
              {
                type: {
                  coding: [
                    {
                      system: 'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-identifier-type-code',
                      code: 'PMJAY',
                    },
                  ],
                },
                system: 'https://bis.pmjay.gov.in',
                value: 'MD5SLS4X5',
              },
            ],
          },
        },
      ],
    };
    const r = validateBundle(bundle);
    expect(r.classified.unknown).toEqual([]);
    expect(r.classified.pmjay).toEqual(
      expect.arrayContaining([
        'https://bis.pmjay.gov.in',
        'https://hcx.pmjay.gov.in/v1/coverageeligibility/check',
        'https://nhcx.pmjay.gov.in',
        'https://payer.pmjay.nha.gov.in',
      ]),
    );
    expect(r.usesPmjayIdentifierType).toBe(true);
    expect(r.unknownIdentifierTypeCodes).toEqual([]);
  });

  it('unknown payer-specific system lands in `unknown`', () => {
    const bundle = {
      resourceType: 'Bundle',
      entry: [
        {
          resource: {
            resourceType: 'Patient',
            identifier: [{ system: 'https://payer-x.example.in/CodeSystem/membership', value: '1' }],
          },
        },
      ],
    };
    const r = validateBundle(bundle);
    expect(r.classified.unknown).toEqual(['https://payer-x.example.in/CodeSystem/membership']);
  });

  it('unknown identifier-type codes (under NDHM system) are surfaced', () => {
    const bundle = {
      resourceType: 'Bundle',
      entry: [
        {
          resource: {
            resourceType: 'Patient',
            identifier: [
              {
                type: {
                  coding: [
                    {
                      system: 'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-identifier-type-code',
                      code: 'CUSTOM-X',
                    },
                  ],
                },
                value: '1',
              },
            ],
          },
        },
      ],
    };
    const r = validateBundle(bundle);
    expect(r.unknownIdentifierTypeCodes).toEqual(['CUSTOM-X']);
    expect(r.usesPmjayIdentifierType).toBe(false);
  });

  it('codes under non-NDHM systems are NOT counted as identifier-type codes', () => {
    // 'PMJAY'-named code under a different system shouldn't trigger
    // the PMJAY identifier-type detection — that's specifically
    // ndhm-identifier-type-code's domain.
    const bundle = {
      resourceType: 'Bundle',
      entry: [
        {
          resource: {
            resourceType: 'Coverage',
            identifier: [
              {
                type: {
                  coding: [
                    {
                      system: 'http://terminology.hl7.org/CodeSystem/v2-0203',
                      code: 'NH',
                    },
                  ],
                },
                value: '1',
              },
            ],
          },
        },
      ],
    };
    const r = validateBundle(bundle);
    expect(r.usesPmjayIdentifierType).toBe(false);
    expect(r.unknownIdentifierTypeCodes).toEqual([]);
  });

  it('handles non-object inputs gracefully (null, primitives)', () => {
    expect(validateBundle(null).classified.unknown).toEqual([]);
    expect(validateBundle('not a bundle').classified.unknown).toEqual([]);
    expect(validateBundle(42).classified.unknown).toEqual([]);
  });
});

describe('Slice BM — summariseFindings', () => {
  it('returns null when nothing surprising was found (PMJAY tenant + PMJAY systems)', () => {
    const r = validateBundle({
      resourceType: 'Bundle',
      entry: [
        {
          resource: {
            resourceType: 'Patient',
            identifier: [{ system: 'https://bis.pmjay.gov.in', value: '1' }],
          },
        },
      ],
    });
    expect(summariseFindings(r, { pmjayMode: 'on' })).toBeNull();
  });

  it('flags PMJAY systems on a non-PMJAY tenant', () => {
    const r = validateBundle({
      resourceType: 'Bundle',
      entry: [
        {
          resource: {
            resourceType: 'Patient',
            identifier: [{ system: 'https://bis.pmjay.gov.in', value: '1' }],
          },
        },
      ],
    });
    const out = summariseFindings(r, { pmjayMode: 'off' });
    expect(out).toMatch(/pmjay-systems-on-non-pmjay-tenant=true/);
  });

  it('lists unknown systems explicitly', () => {
    const r = validateBundle({
      resourceType: 'Bundle',
      entry: [
        {
          resource: {
            resourceType: 'Patient',
            identifier: [{ system: 'https://payer-y.example.in/x', value: '1' }],
          },
        },
      ],
    });
    const out = summariseFindings(r, { pmjayMode: 'on' });
    expect(out).toMatch(/unknown-systems=https:\/\/payer-y\.example\.in\/x/);
  });

  it('lists unknown identifier-type codes explicitly', () => {
    const r = validateBundle({
      resourceType: 'Bundle',
      entry: [
        {
          resource: {
            resourceType: 'Patient',
            identifier: [
              {
                type: {
                  coding: [
                    {
                      system:
                        'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-identifier-type-code',
                      code: 'CUSTOM-Z',
                    },
                  ],
                },
                value: '1',
              },
            ],
          },
        },
      ],
    });
    const out = summariseFindings(r, { pmjayMode: 'on' });
    expect(out).toMatch(/unknown-identifier-type-codes=CUSTOM-Z/);
  });
});
