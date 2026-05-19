import { Injectable, Logger } from '@nestjs/common';

import {
  type AbhaCreationAdapter,
  type AbhaInitInput,
  type AbhaVerifyInput,
} from './abha-creation-adapter.interface';
import {
  type AbhaCreateInitResponse,
  type AbhaCreateVerifyResponse,
} from '@claims/contracts';

// Real ABDM v3 adapter. Wraps the two endpoints:
//
//   POST /v3/profile/account/aadhaar/sendOtp
//        body: { aadhaar }
//        returns: { txnId, mobileNumber (masked) }
//
//   POST /v3/profile/account/aadhaar/verifyOtp
//        body: { txnId, otp }
//        returns: { tokens, ABHAProfile: { ABHANumber, healthIdNumber, ... } }
//
// Headers required on every ABDM v3 call:
//   Authorization: Bearer <client-credentials access token>
//   TIMESTAMP:     ISO8601 of the request time
//   REQUEST-ID:    a fresh UUID per request
//
// This adapter is scaffolded but DOES NOT make real HTTP calls in
// Phase 2 — it throws a clear "not configured" error so deployments
// see the message before they wire credentials. Phase 2.1 (a small
// follow-up) wires the actual fetch calls + ABDM session-token cache
// (shared with the NHCX session-token service pattern).

@Injectable()
export class HttpAbhaCreationAdapter implements AbhaCreationAdapter {
  private readonly log = new Logger(HttpAbhaCreationAdapter.name);

  async init(input: AbhaInitInput): Promise<AbhaCreateInitResponse> {
    this.log.warn(
      `ABHA http adapter not yet wired tenantId=${input.tenantId}. Set ABHA_CREATION_MODE=stub for dev / demo.`,
    );
    throw new Error(
      'ABHA creation HTTP adapter is scaffolded but not wired to ABDM yet. Set ABHA_CREATION_MODE=stub for now.',
    );
  }

  async verify(input: AbhaVerifyInput): Promise<AbhaCreateVerifyResponse> {
    this.log.warn(
      `ABHA http adapter not yet wired tenantId=${input.tenantId}. Set ABHA_CREATION_MODE=stub for dev / demo.`,
    );
    throw new Error(
      'ABHA creation HTTP adapter is scaffolded but not wired to ABDM yet. Set ABHA_CREATION_MODE=stub for now.',
    );
  }
}
