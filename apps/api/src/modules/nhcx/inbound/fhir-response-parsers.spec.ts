// Unit tests for the FHIR R4 inbound response parsers. Each test
// constructs a minimal Bundle of the shape the HCX gateway sends
// and asserts the parsed-output mapping. These are pure-function
// tests — no DI, no async.

import {
  FhirParseError,
  parseClaimResponse,
  parseCommunication,
  parseEligibilityResponse,
  parsePreauthResponse,
} from './fhir-response-parsers';

function bundle(resource: Record<string, unknown>): Record<string, unknown> {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [{ resource }],
  };
}

describe('parseEligibilityResponse', () => {
  it('maps outcome=complete with insurance details to verified', () => {
    const out = parseEligibilityResponse(
      bundle({
        resourceType: 'CoverageEligibilityResponse',
        outcome: 'complete',
        disposition: 'Eligible',
        insurance: [
          {
            coverage: { display: 'Star Health Gold' },
            item: [
              {
                benefit: [{ allowedMoney: { value: 500000, currency: 'INR' } }],
              },
            ],
          },
        ],
      }),
    );
    expect(out.verified).toBe(true);
    expect(out.planName).toBe('Star Health Gold');
    expect(out.sumInsured).toBe(500000);
  });

  it('treats outcome=partial as verified (with caveats)', () => {
    const out = parseEligibilityResponse(
      bundle({
        resourceType: 'CoverageEligibilityResponse',
        outcome: 'partial',
        disposition: 'Eligible with restrictions',
      }),
    );
    expect(out.verified).toBe(true);
    expect(out.failureReason).toBeUndefined();
  });

  it('maps outcome=error to failed with disposition as the reason', () => {
    const out = parseEligibilityResponse(
      bundle({
        resourceType: 'CoverageEligibilityResponse',
        outcome: 'error',
        disposition: 'Policy lapsed',
      }),
    );
    expect(out.verified).toBe(false);
    expect(out.failureReason).toBe('Policy lapsed');
  });

  it('throws when no CoverageEligibilityResponse is present', () => {
    expect(() =>
      parseEligibilityResponse(bundle({ resourceType: 'OperationOutcome' })),
    ).toThrow(FhirParseError);
  });

  it('throws when the bundle is not a Bundle', () => {
    expect(() => parseEligibilityResponse({ foo: 'bar' })).toThrow(FhirParseError);
  });
});

describe('parsePreauthResponse', () => {
  it('maps disposition=approved + total to approved', () => {
    const out = parsePreauthResponse(
      bundle({
        resourceType: 'ClaimResponse',
        outcome: 'complete',
        disposition: 'Approved',
        total: [
          {
            category: { coding: [{ code: 'benefit' }] },
            amount: { value: 75000, currency: 'INR' },
          },
        ],
      }),
    );
    expect(out.kind).toBe('approved');
    expect(out.approvedAmount).toBe(75000);
  });

  it('maps disposition=partial approval to partially_approved', () => {
    const out = parsePreauthResponse(
      bundle({
        resourceType: 'ClaimResponse',
        outcome: 'complete',
        disposition: 'Partial approval — 50%',
        total: [
          {
            category: { coding: [{ code: 'eligible' }] },
            amount: { value: 37500 },
          },
        ],
      }),
    );
    expect(out.kind).toBe('partially_approved');
    expect(out.approvedAmount).toBe(37500);
  });

  it('maps disposition=rejected to rejected with reason', () => {
    const out = parsePreauthResponse(
      bundle({
        resourceType: 'ClaimResponse',
        outcome: 'complete',
        disposition: 'Rejected: not a covered procedure',
      }),
    );
    expect(out.kind).toBe('rejected');
    expect(out.reason).toContain('Rejected');
  });

  it('maps outcome=queued to query_received with disposition as the question', () => {
    const out = parsePreauthResponse(
      bundle({
        resourceType: 'ClaimResponse',
        outcome: 'queued',
        disposition: 'Need surgeon notes for hospitalisation > 5 days',
      }),
    );
    expect(out.kind).toBe('query_received');
    expect(out.queryText).toContain('surgeon notes');
  });

  it('falls back to first numeric total when category coding is missing', () => {
    const out = parsePreauthResponse(
      bundle({
        resourceType: 'ClaimResponse',
        outcome: 'complete',
        disposition: 'Approved',
        total: [{ amount: { value: 12345 } }],
      }),
    );
    expect(out.kind).toBe('approved');
    expect(out.approvedAmount).toBe(12345);
  });
});

describe('parseClaimResponse', () => {
  it('shares the parser with preauth — paid full amount approved', () => {
    const out = parseClaimResponse(
      bundle({
        resourceType: 'ClaimResponse',
        outcome: 'complete',
        disposition: 'approved for payment',
        total: [
          {
            category: { coding: [{ code: 'approved' }] },
            amount: { value: 100000 },
          },
        ],
      }),
    );
    expect(out.kind).toBe('approved');
    expect(out.approvedAmount).toBe(100000);
  });
});

describe('parseCommunication', () => {
  it('classifies a Communication without inResponseTo as a payer query', () => {
    const out = parseCommunication(
      bundle({
        resourceType: 'Communication',
        status: 'completed',
        payload: [{ contentString: 'Please submit MRI report.' }],
      }),
    );
    expect(out.kind).toBe('query');
    expect(out.text).toBe('Please submit MRI report.');
  });

  it('classifies a Communication with inResponseTo as a query response', () => {
    const out = parseCommunication(
      bundle({
        resourceType: 'Communication',
        status: 'completed',
        inResponseTo: [{ reference: 'Communication/abc' }],
        payload: [{ contentString: 'Acknowledged.' }],
      }),
    );
    expect(out.kind).toBe('response');
  });

  it('falls back to contentAttachment.title when contentString is missing', () => {
    const out = parseCommunication(
      bundle({
        resourceType: 'Communication',
        payload: [{ contentAttachment: { title: 'Need consent form' } }],
      }),
    );
    expect(out.text).toBe('Need consent form');
  });

  it('throws when no payload text is present', () => {
    expect(() =>
      parseCommunication(
        bundle({
          resourceType: 'Communication',
          payload: [{}],
        }),
      ),
    ).toThrow(FhirParseError);
  });
});
