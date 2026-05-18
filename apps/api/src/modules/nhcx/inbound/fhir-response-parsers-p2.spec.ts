// P2 inbound parser regression suite. Covers:
//   P2.16 — typed Coverage.benefit[] extraction (deductible / copay /
//           room rent), wallet usedMoney + remaining, Coverage.class[]
//           tier + group, MAND-* mandatory documents
//   P2.21 — PMJAY zero-copay invariant: parser clamps coPayPercent
//           and coPayRupees to 0 when the rail is PMJAY, regardless
//           of payer-returned value (protects against data-entry bugs)

import { parseEligibilityResponse } from './fhir-response-parsers';

function makeBundle(opts: {
  outcome: string;
  coverageType?: string;
  benefits?: Array<{
    code: string;
    allowedValue?: number;
    allowedUnsignedInt?: number;
    allowedString?: string;
  }>;
  balance?: Array<{ code: string; value: number }>;
  classes?: Array<{ code: string; value: string }>;
  mand?: string[];
}): unknown {
  const item = opts.benefits
    ? [
        {
          benefit: opts.benefits.map((b) => ({
            type: { coding: [{ code: b.code }] },
            ...(b.allowedValue !== undefined
              ? { allowedMoney: { value: b.allowedValue, currency: 'INR' } }
              : {}),
            ...(b.allowedUnsignedInt !== undefined
              ? { allowedUnsignedInt: b.allowedUnsignedInt }
              : {}),
            ...(b.allowedString !== undefined ? { allowedString: b.allowedString } : {}),
          })),
        },
      ]
    : [];
  const insurance = [
    {
      coverage: {},
      item,
      ...(opts.balance
        ? {
            balance: opts.balance.map((b) => ({
              term: { coding: [{ code: b.code }] },
              valueMoney: { value: b.value, currency: 'INR' },
            })),
          }
        : {}),
    },
  ];
  const eligibilityResponse = {
    resourceType: 'CoverageEligibilityResponse',
    outcome: opts.outcome,
    insurance,
    ...(opts.mand
      ? {
          extension: opts.mand.map((code) => ({
            url: 'https://nrces.in/ndhm/fhir/r4/StructureDefinition/PmjayMandatoryDocs',
            valueString: code,
          })),
        }
      : {}),
  };
  const coverage = opts.coverageType
    ? {
        resourceType: 'Coverage',
        type: { coding: [{ code: opts.coverageType }] },
        ...(opts.classes
          ? {
              class: opts.classes.map((c) => ({
                type: { coding: [{ code: c.code }] },
                value: c.value,
              })),
            }
          : {}),
      }
    : null;
  return {
    resourceType: 'Bundle',
    entry: [
      { resource: eligibilityResponse },
      ...(coverage ? [{ resource: coverage }] : []),
    ],
  };
}

describe('P2.16 typed benefits extraction', () => {
  it('extracts deductible / room-rent from allowedMoney', () => {
    const r = parseEligibilityResponse(
      makeBundle({
        outcome: 'complete',
        benefits: [
          { code: 'deductible', allowedValue: 5_000 },
          { code: 'room-rent', allowedValue: 4_000 },
        ],
      }),
    );
    expect(r.benefits?.deductibleRupees).toBe(5_000);
    expect(r.benefits?.roomRentLimitRupees).toBe(4_000);
  });

  it('extracts copay percent from allowedUnsignedInt and string form', () => {
    const r1 = parseEligibilityResponse(
      makeBundle({
        outcome: 'complete',
        benefits: [{ code: 'copay', allowedUnsignedInt: 15 }],
      }),
    );
    expect(r1.benefits?.coPayPercent).toBe(15);

    const r2 = parseEligibilityResponse(
      makeBundle({
        outcome: 'complete',
        benefits: [{ code: 'co-pay', allowedString: '20%' }],
      }),
    );
    expect(r2.benefits?.coPayPercent).toBe(20);
  });

  it('returns undefined benefits when no typed entries are present', () => {
    const r = parseEligibilityResponse(makeBundle({ outcome: 'complete' }));
    expect(r.benefits).toBeUndefined();
  });
});

describe('P2.16 wallet usedMoney / remaining', () => {
  it('extracts remaining + used from insurance[0].balance[]', () => {
    const r = parseEligibilityResponse(
      makeBundle({
        outcome: 'complete',
        balance: [
          { code: 'remaining', value: 350_000 },
          { code: 'used', value: 150_000 },
        ],
      }),
    );
    expect(r.walletRemainingRupees).toBe(350_000);
    expect(r.walletUsedRupees).toBe(150_000);
  });
});

describe('P2.16 Coverage.class[] tier + group', () => {
  it('extracts the tier + group classes verbatim', () => {
    const r = parseEligibilityResponse(
      makeBundle({
        outcome: 'complete',
        coverageType: 'PMJAY',
        classes: [
          { code: 'tier', value: 'tier-2' },
          { code: 'group', value: 'SECC' },
        ],
      }),
    );
    expect(r.coverageClasses).toEqual([
      { type: 'tier', value: 'tier-2' },
      { type: 'group', value: 'SECC' },
    ]);
  });
});

describe('P2.16 MAND-* mandatory documents', () => {
  it('extracts MAND-* codes from extensions', () => {
    const r = parseEligibilityResponse(
      makeBundle({
        outcome: 'complete',
        mand: ['MAND-AADHAAR', 'MAND-RATION', 'NOT-A-MAND'],
      }),
    );
    expect(r.mandatoryDocs).toEqual(['MAND-AADHAAR', 'MAND-RATION']);
  });
});

describe('P2.21 PMJAY zero-copay invariant', () => {
  it('clamps coPayPercent to 0 even when the payer returned 15', () => {
    const r = parseEligibilityResponse(
      makeBundle({
        outcome: 'complete',
        coverageType: 'PMJAY',
        benefits: [{ code: 'copay', allowedUnsignedInt: 15 }],
      }),
    );
    expect(r.benefits?.coPayPercent).toBe(0);
  });

  it('clamps coPayRupees to 0 for PMJAY rail', () => {
    const r = parseEligibilityResponse(
      makeBundle({
        outcome: 'complete',
        coverageType: 'PMJAY',
        benefits: [{ code: 'copay', allowedValue: 500 }],
      }),
    );
    expect(r.benefits?.coPayRupees).toBe(0);
  });

  it('leaves private-rail coPay untouched', () => {
    const r = parseEligibilityResponse(
      makeBundle({
        outcome: 'complete',
        coverageType: 'EHCPOL',
        benefits: [{ code: 'copay', allowedUnsignedInt: 15 }],
      }),
    );
    expect(r.benefits?.coPayPercent).toBe(15);
  });

  it('detects PMJAY via insurance[].coverage.identifier.system fallback', () => {
    // No Coverage resource in the bundle, but the eligibilityResponse's
    // insurance[].coverage.identifier.system contains 'pmjay'.
    const bundle = {
      resourceType: 'Bundle',
      entry: [
        {
          resource: {
            resourceType: 'CoverageEligibilityResponse',
            outcome: 'complete',
            insurance: [
              {
                coverage: {
                  identifier: { system: 'https://hcx.pmjay.gov.in/policy', value: 'P-1' },
                },
                item: [
                  {
                    benefit: [
                      { type: { coding: [{ code: 'copay' }] }, allowedUnsignedInt: 10 },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
    };
    const r = parseEligibilityResponse(bundle);
    expect(r.benefits?.coPayPercent).toBe(0);
  });
});
