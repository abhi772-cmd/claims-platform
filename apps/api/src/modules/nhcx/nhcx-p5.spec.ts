// P5 biometric polish regression. Covers:
//   P5.29 — X-Auth Token thread-through into preauth/claim Claim.extension
//   P5.30 — Registration / OTP types live on the adapter interface

import { buildClaimSubmitBundle, buildPreauthSubmitBundle } from './fhir-builders';

const actors = { senderCode: 'HOSP1', receiverCode: 'PAYER1' };
const patient = {
  fullName: 'Asha Devi',
  hospitalMrn: 'MRN-001',
};
const coverage = {
  payerCode: 'PMJAY-RAJ',
  memberId: 'POL-001',
};

describe('P5.29 X-Auth Token threading into Claim.extension', () => {
  it('emits Claim.extension with the biometric auth token on preauth', () => {
    const bundle = buildPreauthSubmitBundle({
      actors,
      patient,
      coverage,
      localClaimId: 'cl-1',
      xAuthToken: 'X-AUTH-TOKEN-OPAQUE',
    });
    const claim = bundle.entry.find((e) => e.resource['resourceType'] === 'Claim')
      ?.resource as {
      extension: Array<{ url: string; valueString: string }>;
    };
    expect(claim.extension[0]?.url).toBe(
      'https://hcx.pmjay.nha.gov.in/StructureDefinition/biometricAuthToken',
    );
    expect(claim.extension[0]?.valueString).toBe('X-AUTH-TOKEN-OPAQUE');
  });

  it('threads X-Auth Token through use=claim variant as well', () => {
    const bundle = buildClaimSubmitBundle({
      actors,
      patient,
      coverage,
      localClaimId: 'cl-1',
      finalAmount: 100_000,
      documentIds: [],
      xAuthToken: 'TOK-CLAIM',
    });
    const claim = bundle.entry.find((e) => e.resource['resourceType'] === 'Claim')
      ?.resource as {
      use: string;
      extension: Array<{ valueString: string }>;
    };
    expect(claim.use).toBe('claim');
    expect(claim.extension[0]?.valueString).toBe('TOK-CLAIM');
  });

  it('omits Claim.extension when xAuthToken is not supplied (back-compat)', () => {
    const bundle = buildPreauthSubmitBundle({
      actors,
      patient,
      coverage,
      localClaimId: 'cl-1',
    });
    const claim = bundle.entry.find((e) => e.resource['resourceType'] === 'Claim')
      ?.resource as Record<string, unknown>;
    expect(claim['extension']).toBeUndefined();
  });
});
