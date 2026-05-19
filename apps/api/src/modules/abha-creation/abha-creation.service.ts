import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  ABHA_CREATION_ADAPTER,
  type AbhaCreationAdapter,
} from './abha-creation-adapter.interface';
import {
  type AbhaCreateInitResponse,
  type AbhaCreateVerifyResponse,
} from '@claims/contracts';

export interface AbhaCreateInitServiceInput {
  tenantId: string;
  actorUserId: string;
  aadhaar: string;
}

export interface AbhaCreateVerifyServiceInput {
  tenantId: string;
  actorUserId: string;
  txnId: string;
  otp: string;
}

// Phase 2 service shell. Pass-through to the adapter for now; Phase 2.1
// will add:
//   * integration_message ledger entries (per CLAUDE.md rule #7 —
//     every external integration call must be logged)
//   * audit_log rows for the demographic-data exchange
//   * rate limit per (tenantId, aadhaar) to prevent OTP flooding
//
// The contract is stable in this slice so the UI can wire against it
// without churn when the persistence layer lands.
@Injectable()
export class AbhaCreationService {
  private readonly log = new Logger(AbhaCreationService.name);

  constructor(
    @Inject(ABHA_CREATION_ADAPTER) private readonly adapter: AbhaCreationAdapter,
  ) {}

  async init(input: AbhaCreateInitServiceInput): Promise<AbhaCreateInitResponse> {
    this.log.log(`abha.init tenantId=${input.tenantId} actor=${input.actorUserId}`);
    return this.adapter.init({
      tenantId: input.tenantId,
      aadhaar: input.aadhaar,
    });
  }

  async verify(input: AbhaCreateVerifyServiceInput): Promise<AbhaCreateVerifyResponse> {
    this.log.log(`abha.verify tenantId=${input.tenantId} actor=${input.actorUserId}`);
    return this.adapter.verify({
      tenantId: input.tenantId,
      txnId: input.txnId,
      otp: input.otp,
    });
  }
}
