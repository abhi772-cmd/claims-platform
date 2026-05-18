// P2.17 regression — partial+queried branch + pipe-delimited audit trail.

import { parseClaimResponse } from './fhir-response-parsers';

function bundleWith(opts: {
  outcome: string;
  disposition?: string;
  reasonCode?: string;
  auditTrail?: string;
}): unknown {
  const extension: Array<Record<string, unknown>> = [];
  if (opts.reasonCode) {
    extension.push({
      url: 'https://hcx.pmjay.nha.gov.in/StructureDefinition/reasonCode',
      valueString: opts.reasonCode,
    });
  }
  if (opts.auditTrail) {
    extension.push({
      url: 'https://hcx.pmjay.nha.gov.in/StructureDefinition/auditTrail',
      valueString: opts.auditTrail,
    });
  }
  return {
    resourceType: 'Bundle',
    entry: [
      {
        resource: {
          resourceType: 'ClaimResponse',
          outcome: opts.outcome,
          ...(opts.disposition !== undefined ? { disposition: opts.disposition } : {}),
          ...(extension.length > 0 ? { extension } : {}),
        },
      },
    ],
  };
}

describe('P2.17 PMJAY partial+queried routes to query_received', () => {
  it('outcome=partial + reasonCode=queried → query_received', () => {
    const r = parseClaimResponse(
      bundleWith({
        outcome: 'partial',
        reasonCode: 'queried',
        disposition: 'Need pre-op clearance from cardiology',
      }),
    );
    expect(r.kind).toBe('query_received');
    expect(r.queryText).toBe('Need pre-op clearance from cardiology');
  });

  it('outcome=partial WITHOUT queried still flows through partially_approved', () => {
    const r = parseClaimResponse(
      bundleWith({
        outcome: 'partial',
        disposition: 'partial approval — see line items',
      }),
    );
    expect(r.kind).toBe('partially_approved');
  });
});

describe('P2.17 pipe-delimited audit-trail parser', () => {
  it('parses event|date|actor triples into structured rows', () => {
    const r = parseClaimResponse(
      bundleWith({
        outcome: 'complete',
        disposition: 'approved',
        auditTrail:
          'submitted|2026-05-01 10:00:00|hospital@hcx\n' +
          'reviewed|2026-05-02 14:00:00|payer1@hcx\n' +
          'approved|2026-05-03 09:00:00|adjudicator-7',
      }),
    );
    expect(r.auditTrail).toEqual([
      { event: 'submitted', occurredAt: '2026-05-01 10:00:00', actor: 'hospital@hcx' },
      { event: 'reviewed', occurredAt: '2026-05-02 14:00:00', actor: 'payer1@hcx' },
      { event: 'approved', occurredAt: '2026-05-03 09:00:00', actor: 'adjudicator-7' },
    ]);
  });

  it('skips malformed rows but keeps well-formed ones', () => {
    const r = parseClaimResponse(
      bundleWith({
        outcome: 'complete',
        disposition: 'approved',
        auditTrail:
          'submitted|2026-05-01|hospital\n' +
          'malformed-row-no-pipes\n' +
          'too|few',
      }),
    );
    expect(r.auditTrail).toEqual([
      { event: 'submitted', occurredAt: '2026-05-01', actor: 'hospital' },
    ]);
  });

  it('returns undefined auditTrail when extension is absent', () => {
    const r = parseClaimResponse(
      bundleWith({ outcome: 'complete', disposition: 'approved' }),
    );
    expect(r.auditTrail).toBeUndefined();
  });
});
