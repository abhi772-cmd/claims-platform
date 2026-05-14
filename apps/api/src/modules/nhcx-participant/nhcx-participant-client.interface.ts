// Slice ON-4 — Thin client wrapping NHA's participant onboarding API.
// Two implementations:
//   StubNhcxParticipantClient — synthesises a participant code from the
//     HFR ID. Used in tests + dev when NHCX_PARTICIPANT_MODE=stub.
//   RealNhcxParticipantClient — wraps NHA's documented HTTP endpoint
//     (lands in a follow-up slice once we have sandbox credentials —
//     see docs/15 open question #5 on NHA participant API stability).
//
// The interface stays narrow: just what slice ON-4 needs. New
// operations (de-register, fetch participant metadata) land alongside
// when called for.

import { type NhcxParticipantRole } from '@claims/contracts';

export const NHCX_PARTICIPANT_CLIENT = Symbol('NHCX_PARTICIPANT_CLIENT');

export interface RegisterParticipantInput {
  // Tenant identity — used for the storage-key namespace + the
  // synthesised participant code on the stub side.
  tenantId: string;
  tenantSlug: string;
  hfrFacilityId: string;
  callbackUrl: string;
  role: NhcxParticipantRole;
  sandboxMode: boolean;
  // Echoed back into integration_message rows so the audit trail
  // shows which ops user kicked off the call.
  initiatedByUserId: string;
}

export interface RegisterParticipantResult {
  // NHA-issued `<id>@hcx` token. The platform stores this in
  // tenant_nhcx_config.participantCode and includes it on every
  // outbound message as `x-hcx-sender-code`.
  participantCode: string;
  // Echoes the input — NHA's API confirms which callback URL it
  // registered against the participant. We persist this so the
  // operator can audit any drift between request and confirmed.
  registeredCallbackUrl: string;
  // Raw response body (for integration_message.rawResponse).
  rawResponse: Record<string, unknown>;
}

export interface NhcxParticipantClient {
  registerParticipant(input: RegisterParticipantInput): Promise<RegisterParticipantResult>;
}
