import { Injectable } from '@nestjs/common';

import {
  type AbhaCreationAdapter,
  type AbhaInitInput,
  type AbhaVerifyInput,
} from './abha-creation-adapter.interface';
import {
  type AbhaCreateInitResponse,
  type AbhaCreateVerifyResponse,
} from '@claims/contracts';

// Bound when ABHA_CREATION_MODE='disabled'. Used by deployments that
// haven't completed ABDM client-KYC and therefore can't legally issue
// ABHAs. The UI calls these endpoints, gets a clean rejection, and
// shows the operator a "this hospital can't generate ABHAs — ask the
// patient to use the ABHA mobile app or visit their nearest enrolment
// centre" message.

@Injectable()
export class DisabledAbhaCreationAdapter implements AbhaCreationAdapter {
  async init(_input: AbhaInitInput): Promise<AbhaCreateInitResponse> {
    throw new Error(
      'ABHA creation is disabled for this tenant. The tenant has not completed ABDM client KYC.',
    );
  }

  async verify(_input: AbhaVerifyInput): Promise<AbhaCreateVerifyResponse> {
    throw new Error(
      'ABHA creation is disabled for this tenant. The tenant has not completed ABDM client KYC.',
    );
  }
}
