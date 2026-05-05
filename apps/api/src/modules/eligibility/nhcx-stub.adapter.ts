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
