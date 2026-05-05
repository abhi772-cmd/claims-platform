import { type ClaimEventType, type ClaimStatus } from '@claims/contracts';
import { Injectable } from '@nestjs/common';

import { ClaimService } from './claim.service';
import { nextStatus } from './claim.state-machine';

export interface ReconstructedClaim {
  status: ClaimStatus;
  // Number of events applied. Useful for tests + sanity-check
  // assertions: it should equal the row count for the claim.
  eventCount: number;
  // History of (event, resultingStatus) pairs. Same shape as the
  // recorded events but derived from the transition table — proves the
  // table and the materialised state agree.
  history: ReadonlyArray<{
    eventType: ClaimEventType;
    occurredAt: Date;
    derivedStatus: ClaimStatus;
    storedStatus: ClaimStatus;
  }>;
  // True when every step's derived status matches the stored
  // resultingStatus on disk. False is a serious signal: it means
  // either the transition table changed in a non-backwards-compatible
  // way OR somebody wrote a ClaimEvent outside ClaimService.
  consistent: boolean;
}

// Replays a claim's events through the state machine and reports the
// reconstructed status alongside what's stored on disk. Used by:
//   - Disputes / forensics ("show me how this claim ended up here").
//   - The periodic consistency-check job (Sprint 3 backlog).
//   - Tests, here in Sprint 2.
//
// Pure read path — no writes, no side effects.
@Injectable()
export class ClaimReconstructionService {
  constructor(private readonly claims: ClaimService) {}

  async replay(tenantId: string, claimId: string): Promise<ReconstructedClaim> {
    const events = await this.claims.listEvents(tenantId, claimId);
    let status: ClaimStatus | null = null;
    const history: ReconstructedClaim['history'] = events.map((e) => {
      const derived = nextStatus(status, e.eventType);
      const result = derived ?? e.resultingStatus;
      status = result;
      return {
        eventType: e.eventType,
        occurredAt: e.occurredAt,
        derivedStatus: result,
        storedStatus: e.resultingStatus,
      };
    });
    return {
      status: status ?? 'INITIATED',
      eventCount: events.length,
      history,
      consistent: history.every((h) => h.derivedStatus === h.storedStatus),
    };
  }
}
