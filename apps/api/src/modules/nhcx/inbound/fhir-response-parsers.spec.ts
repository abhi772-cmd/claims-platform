// Unit tests for the FHIR R4 inbound response parsers. Each test
// constructs a minimal Bundle of the shape the HCX gateway sends
// and asserts the parsed-output mapping. These are pure-function
// tests — no DI, no async.

import {
  FhirParseError,
  parseClaimResponse,
  parseCommunication,
  parseEligibilityResponse,
  parseInsurancePlan,
  parsePaymentNotice,
  parsePreauthResponse,
  parseTask,
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

describe('parsePaymentNotice', () => {
  it('maps status=active + amount + paymentDate to a paid notice', () => {
    const out = parsePaymentNotice(
      bundle({
        resourceType: 'PaymentNotice',
        status: 'active',
        amount: { value: 75000, currency: 'INR' },
        paymentDate: '2026-05-07T10:30:00Z',
        identifier: [{ system: 'bank', value: 'BANK-9001' }],
        request: {
          reference: 'Claim/STUB-CL-12345',
        },
      }),
    );
    expect(out.kind).toBe('paid');
    expect(out.receivedAmount).toBe(75000);
    expect(out.receivedAt).toBe('2026-05-07T10:30:00Z');
    expect(out.bankTxnId).toBe('BANK-9001');
    expect(out.claimRefNum).toBe('STUB-CL-12345');
  });

  it('falls back to created when paymentDate missing', () => {
    const out = parsePaymentNotice(
      bundle({
        resourceType: 'PaymentNotice',
        status: 'completed',
        amount: { value: 100, currency: 'INR' },
        created: '2026-05-07T10:30:00Z',
      }),
    );
    expect(out.kind).toBe('paid');
    expect(out.receivedAt).toBe('2026-05-07T10:30:00Z');
  });

  it('extracts bankTxnId from request.identifier when top-level identifier is absent', () => {
    // Paramount-style nesting per the parser's docstring.
    const out = parsePaymentNotice(
      bundle({
        resourceType: 'PaymentNotice',
        status: 'active',
        amount: { value: 50, currency: 'INR' },
        request: {
          identifier: { system: 'bank', value: 'PARAM-TXN-77' },
          reference: 'Claim/REF-A1',
        },
      }),
    );
    expect(out.bankTxnId).toBe('PARAM-TXN-77');
    expect(out.claimRefNum).toBe('REF-A1');
  });

  it('status=cancelled → kind=cancelled (no transition driven)', () => {
    const out = parsePaymentNotice(
      bundle({
        resourceType: 'PaymentNotice',
        status: 'cancelled',
        amount: { value: 0 },
      }),
    );
    expect(out.kind).toBe('cancelled');
  });

  it('truncates fractional rupee amounts (defensive against payer floats)', () => {
    const out = parsePaymentNotice(
      bundle({
        resourceType: 'PaymentNotice',
        status: 'active',
        amount: { value: 1234.99 },
      }),
    );
    expect(out.receivedAmount).toBe(1234);
  });

  it('throws when amount.value is missing or non-numeric', () => {
    expect(() =>
      parsePaymentNotice(
        bundle({
          resourceType: 'PaymentNotice',
          status: 'active',
          amount: { currency: 'INR' },
        }),
      ),
    ).toThrow(FhirParseError);
  });

  it('throws when no PaymentNotice resource is in the bundle', () => {
    expect(() => parsePaymentNotice(bundle({ resourceType: 'Patient' }))).toThrow(
      FhirParseError,
    );
  });

  it('claimRefNum may be omitted from output if neither reference nor identifier is present', () => {
    const out = parsePaymentNotice(
      bundle({
        resourceType: 'PaymentNotice',
        status: 'active',
        amount: { value: 100 },
      }),
    );
    expect(out.claimRefNum).toBeUndefined();
  });
});

describe('parseInsurancePlan', () => {
  it('extracts identifier, name, status, and type code', () => {
    const out = parseInsurancePlan(
      bundle({
        resourceType: 'InsurancePlan',
        identifier: [{ system: 'plan', value: 'STAR-GOLD-2026' }],
        name: 'Star Health Gold 2026',
        status: 'active',
        type: [{ coding: [{ system: 'plan-type', code: 'medical' }] }],
      }),
    );
    expect(out).toEqual({
      planId: 'STAR-GOLD-2026',
      name: 'Star Health Gold 2026',
      status: 'active',
      type: 'medical',
    });
  });

  it('omits fields the gateway did not populate', () => {
    const out = parseInsurancePlan(
      bundle({ resourceType: 'InsurancePlan', name: 'Plan X' }),
    );
    expect(out).toEqual({ name: 'Plan X' });
  });

  it('throws when no InsurancePlan resource is in the bundle', () => {
    expect(() => parseInsurancePlan(bundle({ resourceType: 'Patient' }))).toThrow(
      FhirParseError,
    );
  });

  it('falls back through identifier list to find the first non-empty value', () => {
    const out = parseInsurancePlan(
      bundle({
        resourceType: 'InsurancePlan',
        identifier: [{ system: 'plan', value: '' }, { system: 'plan', value: 'P-2' }],
      }),
    );
    expect(out.planId).toBe('P-2');
  });
});

describe('parseTask', () => {
  it('extracts status, description, and focus reference', () => {
    const out = parseTask(
      bundle({
        resourceType: 'Task',
        status: 'requested',
        description: 'Please re-upload the discharge summary',
        focus: { reference: 'Claim/STUB-CL-12345' },
      }),
    );
    expect(out).toEqual({
      status: 'requested',
      description: 'Please re-upload the discharge summary',
      focusRef: 'Claim/STUB-CL-12345',
    });
  });

  it('falls back to focus.identifier.value when reference is absent', () => {
    const out = parseTask(
      bundle({
        resourceType: 'Task',
        status: 'in-progress',
        focus: { identifier: { system: 'claim', value: 'REF-A1' } },
      }),
    );
    expect(out.focusRef).toBe('REF-A1');
  });

  it('omits fields the gateway did not populate', () => {
    const out = parseTask(bundle({ resourceType: 'Task', status: 'completed' }));
    expect(out).toEqual({ status: 'completed' });
  });

  it('throws when no Task resource is in the bundle', () => {
    expect(() => parseTask(bundle({ resourceType: 'Patient' }))).toThrow(FhirParseError);
  });
});
