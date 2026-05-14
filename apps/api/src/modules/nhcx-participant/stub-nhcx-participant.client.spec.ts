// Sanity test for the stub adapter. Behaviour is deterministic by
// design — the service spec + e2e rely on the same shape.

import { StubNhcxParticipantClient } from './stub-nhcx-participant.client';

describe('StubNhcxParticipantClient', () => {
  it('synthesises a sandbox-suffixed participant code', async () => {
    const client = new StubNhcxParticipantClient();
    const out = await client.registerParticipant({
      tenantId: 't',
      tenantSlug: 'apollo-indore',
      hfrFacilityId: 'HFR123456',
      callbackUrl: 'https://callback.example/x',
      role: 'provider',
      sandboxMode: true,
      initiatedByUserId: 'u',
    });
    expect(out.participantCode).toBe('apollo-indore@hcx');
    expect(out.registeredCallbackUrl).toBe('https://callback.example/x');
    expect(out.rawResponse.environment).toBe('sandbox');
  });

  it('flips the suffix for production mode', async () => {
    const client = new StubNhcxParticipantClient();
    const out = await client.registerParticipant({
      tenantId: 't',
      tenantSlug: 'apollo-indore',
      hfrFacilityId: 'HFR123456',
      callbackUrl: 'https://callback.example/x',
      role: 'provider',
      sandboxMode: false,
      initiatedByUserId: 'u',
    });
    expect(out.participantCode).toBe('apollo-indore@hcx-prod');
    expect(out.rawResponse.environment).toBe('production');
  });
});
