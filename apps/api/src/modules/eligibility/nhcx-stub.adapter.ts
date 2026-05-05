import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { type AppConfig } from '../../config/configuration';

export interface AdapterEligibilityRequest {
  tenantId: string;
  claimId: string;
  hospitalMrn: string;
  patientName: string;
  policyNumber?: string;
  payerCode?: string;
}

export interface AdapterEligibilityResponse {
  verified: boolean;
  planName?: string;
  sumInsured?: number;
  failureReason?: string;
  correlationId: string;
  // Echoed in the inbound message body — useful for the ledger.
  rawResponse: Record<string, unknown>;
  // Mock latency we'd otherwise be blocked on; kept tiny so tests
  // don't drag.
  latencyMs: number;
}

// Stub adapter that mirrors the shape of the eventual real NHCX
// eligibility call. Behaviour is driven by env:
//   NHCX_STUB_VERIFY_DEFAULT  ('true' | 'false') — outcome when no
//                                                  override matches.
//   NHCX_STUB_MRN_FAIL_LIST   comma-separated MRNs that always fail.
// Tests override via process.env before booting the module.
@Injectable()
export class NhcxStubAdapter {
  private readonly log = new Logger(NhcxStubAdapter.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async verifyEligibility(input: AdapterEligibilityRequest): Promise<AdapterEligibilityResponse> {
    const correlationId = randomUUID();
    const failList = this.parseFailList();
    const defaultVerify = this.config.get('NHCX_STUB_VERIFY_DEFAULT', { infer: true });
    const verified = !failList.has(input.hospitalMrn) && defaultVerify;

    const rawResponse: Record<string, unknown> = {
      correlationId,
      timestamp: new Date().toISOString(),
      result: verified ? 'eligible' : 'not_eligible',
      ...(verified
        ? { planName: 'Stub Health Insurance Gold', sumInsured: 500_000 }
        : { failureReason: 'Plan not active or unknown member.' }),
      // Mock the NHCX FHIR Bundle envelope at the top level so a
      // future swap to the real adapter doesn't change the shape that
      // hits integration_message.
      bundleType: 'CoverageEligibilityResponse',
    };
    this.log.log(
      `nhcx stub eligibility tenantId=${input.tenantId} mrn=${input.hospitalMrn} verified=${verified}`,
    );

    return verified
      ? {
          verified: true,
          planName: 'Stub Health Insurance Gold',
          sumInsured: 500_000,
          correlationId,
          rawResponse,
          latencyMs: 5,
        }
      : {
          verified: false,
          failureReason: 'Plan not active or unknown member.',
          correlationId,
          rawResponse,
          latencyMs: 5,
        };
  }

  // Pre-auth submit. Adapter just acknowledges receipt with a payer
  // reference number — the actual decision arrives later via
  // `respondPreauthQuery` / a `decideStub` callback.
  async submitPreauth(input: {
    tenantId: string;
    claimId: string;
    requestedAmount: number | null;
  }): Promise<{
    acknowledged: boolean;
    payerRefNum: string;
    correlationId: string;
    rawRequest: Record<string, unknown>;
    rawResponse: Record<string, unknown>;
  }> {
    const correlationId = randomUUID();
    const payerRefNum = `STUB-PA-${randomUUID().slice(0, 8).toUpperCase()}`;
    const rawRequest = {
      bundleType: 'Claim',
      use: 'preauthorization',
      tenantId: input.tenantId,
      claimId: input.claimId,
      requestedAmount: input.requestedAmount,
    };
    const rawResponse = {
      bundleType: 'ClaimResponse',
      outcome: 'queued',
      payerRefNum,
      correlationId,
      timestamp: new Date().toISOString(),
    };
    this.log.log(
      `nhcx stub preauth.submit tenantId=${input.tenantId} claimId=${input.claimId} payerRef=${payerRefNum}`,
    );
    return { acknowledged: true, payerRefNum, correlationId, rawRequest, rawResponse };
  }

  // Pre-auth query response. Stub mirrors submit — acknowledges, no
  // decision; the decision is injected by ops via the decision endpoint
  // until Slice P delivers the real callback path.
  async respondPreauthQuery(input: {
    tenantId: string;
    claimId: string;
    queryId: string;
    responseText: string;
  }): Promise<{
    correlationId: string;
    rawRequest: Record<string, unknown>;
    rawResponse: Record<string, unknown>;
  }> {
    const correlationId = randomUUID();
    return {
      correlationId,
      rawRequest: {
        bundleType: 'Communication',
        operation: 'preauth.query.respond',
        ...input,
      },
      rawResponse: {
        bundleType: 'CommunicationResponse',
        outcome: 'queued',
        correlationId,
        timestamp: new Date().toISOString(),
      },
    };
  }

  // Discharge bundle submit. Stub acknowledges; the real adapter will
  // build a FHIR Communication bundle with discharge_summary references
  // and POST it to NHCX.
  async submitDischarge(input: {
    tenantId: string;
    claimId: string;
    documentIds: string[];
  }): Promise<{
    correlationId: string;
    rawRequest: Record<string, unknown>;
    rawResponse: Record<string, unknown>;
  }> {
    const correlationId = randomUUID();
    return {
      correlationId,
      rawRequest: {
        bundleType: 'Communication',
        operation: 'discharge.submit',
        ...input,
      },
      rawResponse: {
        bundleType: 'CommunicationResponse',
        outcome: 'acknowledged',
        correlationId,
        timestamp: new Date().toISOString(),
      },
    };
  }

  // Final claim submit — same shape as preauth.submit. Returns a
  // claimRefNum. Real decision arrives via callback or (V1) the
  // admin-issued decision endpoint.
  async submitClaim(input: {
    tenantId: string;
    claimId: string;
    finalAmount: number;
  }): Promise<{
    acknowledged: boolean;
    claimRefNum: string;
    correlationId: string;
    rawRequest: Record<string, unknown>;
    rawResponse: Record<string, unknown>;
  }> {
    const correlationId = randomUUID();
    const claimRefNum = `STUB-CL-${randomUUID().slice(0, 8).toUpperCase()}`;
    return {
      acknowledged: true,
      claimRefNum,
      correlationId,
      rawRequest: {
        bundleType: 'Claim',
        use: 'claim',
        tenantId: input.tenantId,
        claimId: input.claimId,
        finalAmount: input.finalAmount,
      },
      rawResponse: {
        bundleType: 'ClaimResponse',
        outcome: 'queued',
        claimRefNum,
        correlationId,
        timestamp: new Date().toISOString(),
      },
    };
  }

  private parseFailList(): ReadonlySet<string> {
    const raw = this.config.get('NHCX_STUB_MRN_FAIL_LIST', { infer: true });
    if (!raw) return new Set();
    return new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
  }
}
