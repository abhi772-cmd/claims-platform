import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  type AdapterClaimSubmitInput,
  type AdapterClaimSubmitResult,
  type AdapterDischargeSubmitInput,
  type AdapterEligibilityRequest,
  type AdapterEligibilityResponse,
  type AdapterEnvelopedResult,
  type AdapterPreauthCancelInput,
  type AdapterPreauthCancelResult,
  type AdapterPreauthQueryRespondInput,
  type AdapterPreauthSubmitInput,
  type AdapterPreauthSubmitResult,
  type NhcxAdapter,
} from './nhcx-adapter.interface';
import { type AppConfig } from '../../config/configuration';

// Stub adapter — env-driven outcomes, no external HTTP calls. Used when
// NHCX_MODE=stub (the default for dev + CI). The real adapter has the
// same interface so consumers don't see the difference.
@Injectable()
export class NhcxStubAdapter implements NhcxAdapter {
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

  async submitPreauth(input: AdapterPreauthSubmitInput): Promise<AdapterPreauthSubmitResult> {
    const correlationId = randomUUID();
    const payerRefNum = `STUB-PA-${randomUUID().slice(0, 8).toUpperCase()}`;
    return {
      acknowledged: true,
      payerRefNum,
      correlationId,
      // Echo the full enriched input back so integration tests can
      // verify orchestrator → adapter wiring (patient + coverage +
      // diagnosis fields). The JWE adapter materialises these into a
      // real FHIR Bundle; the stub keeps them as a flat object.
      rawRequest: {
        bundleType: 'Claim',
        use: 'preauthorization',
        ...input,
      },
      rawResponse: {
        bundleType: 'ClaimResponse',
        outcome: 'queued',
        payerRefNum,
        correlationId,
        timestamp: new Date().toISOString(),
      },
    };
  }

  async respondPreauthQuery(
    input: AdapterPreauthQueryRespondInput,
  ): Promise<AdapterEnvelopedResult> {
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

  async submitDischarge(input: AdapterDischargeSubmitInput): Promise<AdapterEnvelopedResult> {
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

  async submitClaim(input: AdapterClaimSubmitInput): Promise<AdapterClaimSubmitResult> {
    const correlationId = randomUUID();
    const claimRefNum = `STUB-CL-${randomUUID().slice(0, 8).toUpperCase()}`;
    return {
      acknowledged: true,
      claimRefNum,
      correlationId,
      // Echo the full enriched input (patient + coverage + clinical
      // fields + document ids) so tests can verify wiring.
      rawRequest: {
        bundleType: 'Claim',
        use: 'claim',
        ...input,
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

  // Slice BH — PMJAY preauth cancel. Stub echoes the input back so
  // tests can verify the orchestrator → adapter wiring without
  // standing up a real FHIR pipeline.
  async cancelPreauth(input: AdapterPreauthCancelInput): Promise<AdapterPreauthCancelResult> {
    const correlationId = randomUUID();
    return {
      acknowledged: true,
      correlationId,
      rawRequest: {
        bundleType: 'Task',
        operation: 'task/submit',
        code: 'cancel',
        inputType: 'ClaimNumber',
        ...input,
      },
      rawResponse: {
        bundleType: 'TaskResponse',
        outcome: 'queued',
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
