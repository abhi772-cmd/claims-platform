import { Injectable } from '@nestjs/common';

import {
  type NhcxParticipantClient,
  type RegisterParticipantInput,
  type RegisterParticipantResult,
} from './nhcx-participant-client.interface';

// Slice ON-4 stub — synthesises a participant code shaped like NHA's
// real format (`<slug>@hcx` for sandbox, `<slug>@hcx-prod` for prod).
// Returns deterministically so tests can assert against a stable
// string without seeding randomness.
//
// Real-mode adapter (HTTP wrapper around NHA's participant API)
// lands in a follow-up slice once sandbox credentials + the exact
// endpoint shape are confirmed — see docs/15 open question #5.
@Injectable()
export class StubNhcxParticipantClient implements NhcxParticipantClient {
  async registerParticipant(
    input: RegisterParticipantInput,
  ): Promise<RegisterParticipantResult> {
    // Defensive: NHA's real participant code uses the hospital's
    // chosen slug rather than the platform's, but for stub purposes
    // tenantSlug is a fine deterministic source.
    const suffix = input.sandboxMode ? 'hcx' : 'hcx-prod';
    const participantCode = `${input.tenantSlug}@${suffix}`;
    return {
      participantCode,
      registeredCallbackUrl: input.callbackUrl,
      rawResponse: {
        // Shape mirrors what NHA's docs say the participant API
        // returns. The real adapter will produce the same fields; the
        // stub keeps it minimal but representative so integration_message
        // rows are useful even in dev.
        status: 'registered',
        participant_code: participantCode,
        role: input.role,
        callback_url: input.callbackUrl,
        hfr_facility_id: input.hfrFacilityId,
        environment: input.sandboxMode ? 'sandbox' : 'production',
        registered_at: new Date().toISOString(),
      },
    };
  }
}
