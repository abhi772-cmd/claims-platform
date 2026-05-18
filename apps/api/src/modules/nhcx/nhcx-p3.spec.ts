// P3 settlement + InsurancePlan regression suite.
//
// P3.22 — PaymentReconciliation parser (UTR + total + detail[] + kind)
// P3.23 — paymentack builder (FHIR PaymentReconciliation outbound)
// P3.24 — InsurancePlan parser (specialties + STG ref + Claim-Condition)

import { buildPaymentAckBundle } from './fhir-builders';
import {
  parseInsurancePlanFull,
  parsePaymentReconciliation,
} from './inbound/fhir-response-parsers';

describe('P3.22 PaymentReconciliation parser', () => {
  function reconBundle(opts: {
    utr?: string;
    total?: number;
    paymentDate?: string;
    detail?: Array<{ claim: string; amount: number; kind?: string; note?: string }>;
  }): unknown {
    const recon: Record<string, unknown> = {
      resourceType: 'PaymentReconciliation',
      identifier: opts.utr ? [{ value: opts.utr }] : [],
      paymentAmount: { value: opts.total ?? 0, currency: 'INR' },
      paymentDate: opts.paymentDate ?? '2026-05-15',
      detail: (opts.detail ?? []).map((d) => ({
        request: { identifier: { value: d.claim } },
        amount: { value: d.amount, currency: 'INR' },
        ...(d.kind
          ? { type: { coding: [{ code: d.kind }] } }
          : {}),
        ...(d.note ? { note: d.note } : {}),
      })),
    };
    return {
      resourceType: 'Bundle',
      entry: [{ resource: recon }],
    };
  }

  it('extracts UTR + total + payment date + per-claim detail', () => {
    const r = parsePaymentReconciliation(
      reconBundle({
        utr: 'NEFTABCD1234567890',
        total: 500_000,
        paymentDate: '2026-05-15',
        detail: [
          { claim: 'CL-1', amount: 300_000, kind: 'payment' },
          { claim: 'CL-2', amount: 200_000, kind: 'payment' },
        ],
      }),
    );
    expect(r.utr).toBe('NEFTABCD1234567890');
    expect(r.totalRupees).toBe(500_000);
    expect(r.paymentDate).toBe('2026-05-15');
    expect(r.detail).toHaveLength(2);
    expect(r.detail[0]?.claimRefNum).toBe('CL-1');
    expect(r.detail[0]?.amountRupees).toBe(300_000);
  });

  it('classifies tds + penalty detail rows by type.coding.code', () => {
    const r = parsePaymentReconciliation(
      reconBundle({
        utr: 'UTR-1',
        total: 200_000,
        detail: [
          { claim: 'CL-1', amount: 250_000, kind: 'payment' },
          { claim: 'CL-1', amount: -25_000, kind: 'TDS' },
          { claim: 'CL-1', amount: -25_000, kind: 'penalty' },
        ],
      }),
    );
    expect(r.detail.map((d) => d.kind)).toEqual(['payment', 'tds', 'penalty']);
  });

  it('throws FhirParseError when UTR is missing', () => {
    expect(() => parsePaymentReconciliation(reconBundle({ total: 100 }))).toThrow(/UTR/);
  });
});

describe('P3.23 paymentack outbound builder', () => {
  it('emits a PaymentReconciliation Bundle with the UTR + outcome', () => {
    const bundle = buildPaymentAckBundle({
      actors: { senderCode: 'HOSP1', receiverCode: 'PAYER1' },
      utr: 'NEFT-9999',
      totalRupees: 500_000,
      outcome: 'reconciled',
      note: 'all good',
    });
    expect(bundle.meta.profile[0]).toBe(
      'https://nrces.in/ndhm/fhir/r4/StructureDefinition/PaymentReconciliationBundle',
    );
    const reconRow = bundle.entry.find((e) => e.resource['resourceType'] === 'PaymentReconciliation');
    expect(reconRow).toBeDefined();
    const recon = reconRow!.resource as {
      identifier: Array<{ system: string; value: string }>;
      outcome: string;
      disposition: string;
      paymentAmount: { value: number };
    };
    expect(recon.identifier[0]?.value).toBe('NEFT-9999');
    expect(recon.outcome).toBe('complete');
    expect(recon.disposition).toBe('reconciled');
    expect(recon.paymentAmount.value).toBe(500_000);
  });

  it('maps short-paid → outcome=partial, disputed → outcome=error', () => {
    const partial = buildPaymentAckBundle({
      actors: { senderCode: 'H', receiverCode: 'P' },
      utr: 'U',
      totalRupees: 100,
      outcome: 'short-paid',
    });
    expect((partial.entry[0]!.resource as { outcome: string }).outcome).toBe('partial');

    const disputed = buildPaymentAckBundle({
      actors: { senderCode: 'H', receiverCode: 'P' },
      utr: 'U',
      totalRupees: 100,
      outcome: 'disputed',
    });
    expect((disputed.entry[0]!.resource as { outcome: string }).outcome).toBe('error');
  });
});

describe('P3.24 InsurancePlan full parser', () => {
  it('extracts plan metadata + specialty packages + STG refs + conditions', () => {
    const bundle = {
      resourceType: 'Bundle',
      entry: [
        {
          resource: {
            resourceType: 'InsurancePlan',
            identifier: [{ value: 'PMJAY-PKG-2026' }],
            name: 'PMJAY Package Master 2026',
            status: 'active',
            meta: { versionId: '7' },
            coverage: [
              {
                type: { coding: [{ code: 'CT', display: 'Cardiology' }] },
                benefit: [
                  {
                    type: { coding: [{ code: 'M-CT-001', display: 'CABG' }] },
                    limit: [{ value: { value: 110_000, currency: 'INR' } }],
                    extension: [
                      {
                        url: 'https://nrces.in/ndhm/fhir/r4/StructureDefinition/StgReference',
                        valueReference: { reference: 'PlanDefinition/STG-CT-001' },
                      },
                    ],
                  },
                  {
                    type: { coding: [{ code: 'M-CT-002', display: 'PTCA' }] },
                    limit: [{ value: { value: 85_000, currency: 'INR' } }],
                  },
                ],
              },
              {
                type: { coding: [{ code: 'ORTH' }] },
                benefit: [
                  {
                    type: { coding: [{ code: 'M-ORTH-001', display: 'TKR' }] },
                    limit: [{ value: { value: 95_000, currency: 'INR' } }],
                  },
                ],
              },
            ],
            extension: [
              {
                url: 'https://nrces.in/ndhm/fhir/r4/StructureDefinition/ClaimConditionExtension',
                extension: [
                  { url: 'package', valueCode: 'M-CT-001' },
                  { url: 'condition', valueCode: 'pre-op-test' },
                  { url: 'condition', valueCode: 'requires-second-opinion' },
                ],
              },
              {
                url: 'https://nrces.in/ndhm/fhir/r4/StructureDefinition/ClaimConditionExtension',
                extension: [
                  { url: 'package', valueCode: 'M-ORTH-001' },
                  { url: 'condition', valueCode: 'age-min-50' },
                ],
              },
            ],
          },
        },
      ],
    };
    const r = parseInsurancePlanFull(bundle);
    expect(r.planId).toBe('PMJAY-PKG-2026');
    expect(r.name).toBe('PMJAY Package Master 2026');
    expect(r.status).toBe('active');
    expect(r.versionId).toBe('7');
    expect(r.specialties).toHaveLength(2);
    const ct = r.specialties.find((s) => s.specialty === 'CT');
    expect(ct?.packages).toHaveLength(2);
    expect(ct?.packages[0]?.code).toBe('M-CT-001');
    expect(ct?.packages[0]?.ceilingRupees).toBe(110_000);
    expect(ct?.packages[0]?.stgRef).toBe('PlanDefinition/STG-CT-001');
    expect(ct?.packages[1]?.stgRef).toBeUndefined();
    expect(r.conditions).toHaveLength(2);
    const cabg = r.conditions.find((c) => c.packageCode === 'M-CT-001');
    expect(cabg?.conditions).toEqual(['pre-op-test', 'requires-second-opinion']);
  });

  it('throws FhirParseError when InsurancePlan resource is missing', () => {
    expect(() => parseInsurancePlanFull({ resourceType: 'Bundle', entry: [] })).toThrow(
      /InsurancePlan/,
    );
  });
});
