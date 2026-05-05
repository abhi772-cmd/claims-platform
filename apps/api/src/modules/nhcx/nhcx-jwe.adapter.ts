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
  type AdapterPreauthQueryRespondInput,
  type AdapterPreauthSubmitInput,
  type AdapterPreauthSubmitResult,
  type NhcxAdapter,
} from './nhcx-adapter.interface';
import { decryptFromParticipant, encryptToParticipant } from './nhcx.crypto';
import { type AppConfig } from '../../config/configuration';

// Minimal NHCX FHIR R4 envelope. The real NHCX gateway requires:
//   * a Bundle resource with type=collection
//   * a Communication / Claim / CoverageEligibilityRequest as the
//     root resource
//   * x-hcx-* headers carrying participant codes + correlation id
//
// We don't (yet) build the full FHIR resources — that's a Sprint 3
// hardening item once the test gateway is available. For Slice P, the
// envelope we POST is a minimal JWE-wrapped JSON document that the real
// gateway would reject but our integration test (which decrypts on the
// other side) accepts. The shape we wrap is preserved end-to-end so a
// future Sprint 3 PR can extend `buildBundle()` without changing
// callers.
interface NhcxBundle<T> {
  resourceType: 'Bundle';
  type: 'collection';
  meta: {
    timestamp: string;
    correlationId: string;
    senderCode: string;
    operation: string;
  };
  payload: T;
}

interface OperationResult<T> {
  correlationId: string;
  request: NhcxBundle<unknown>;
  response: T;
  latencyMs: number;
}

const HEADER_CORRELATION = 'x-hcx-correlation-id';
const HEADER_SENDER = 'x-hcx-sender-code';
const HEADER_OPERATION = 'x-hcx-operation';

@Injectable()
export class NhcxJweAdapter implements NhcxAdapter {
  private readonly log = new Logger(NhcxJweAdapter.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async verifyEligibility(input: AdapterEligibilityRequest): Promise<AdapterEligibilityResponse> {
    const op = await this.callOperation<{
      verified: boolean;
      planName?: string;
      sumInsured?: number;
      failureReason?: string;
    }>('coverage-eligibility/check', {
      patientName: input.patientName,
      hospitalMrn: input.hospitalMrn,
      policyNumber: input.policyNumber,
      payerCode: input.payerCode,
      tenantId: input.tenantId,
      claimId: input.claimId,
    });

    return {
      verified: op.response.verified,
      ...(op.response.planName !== undefined ? { planName: op.response.planName } : {}),
      ...(op.response.sumInsured !== undefined ? { sumInsured: op.response.sumInsured } : {}),
      ...(op.response.failureReason !== undefined
        ? { failureReason: op.response.failureReason }
        : {}),
      correlationId: op.correlationId,
      rawResponse: op.response as unknown as Record<string, unknown>,
      latencyMs: op.latencyMs,
    };
  }

  async submitPreauth(input: AdapterPreauthSubmitInput): Promise<AdapterPreauthSubmitResult> {
    const op = await this.callOperation<{
      acknowledged: boolean;
      payerRefNum: string;
    }>('preauth/submit', {
      tenantId: input.tenantId,
      claimId: input.claimId,
      requestedAmount: input.requestedAmount,
    });
    return {
      acknowledged: op.response.acknowledged,
      payerRefNum: op.response.payerRefNum,
      correlationId: op.correlationId,
      rawRequest: op.request as unknown as Record<string, unknown>,
      rawResponse: op.response as unknown as Record<string, unknown>,
    };
  }

  async respondPreauthQuery(
    input: AdapterPreauthQueryRespondInput,
  ): Promise<AdapterEnvelopedResult> {
    const op = await this.callOperation('preauth/query/respond', input);
    return {
      correlationId: op.correlationId,
      rawRequest: op.request as unknown as Record<string, unknown>,
      rawResponse: op.response as unknown as Record<string, unknown>,
    };
  }

  async submitDischarge(input: AdapterDischargeSubmitInput): Promise<AdapterEnvelopedResult> {
    const op = await this.callOperation('discharge/submit', input);
    return {
      correlationId: op.correlationId,
      rawRequest: op.request as unknown as Record<string, unknown>,
      rawResponse: op.response as unknown as Record<string, unknown>,
    };
  }

  async submitClaim(input: AdapterClaimSubmitInput): Promise<AdapterClaimSubmitResult> {
    const op = await this.callOperation<{
      acknowledged: boolean;
      claimRefNum: string;
    }>('claim/submit', {
      tenantId: input.tenantId,
      claimId: input.claimId,
      finalAmount: input.finalAmount,
    });
    return {
      acknowledged: op.response.acknowledged,
      claimRefNum: op.response.claimRefNum,
      correlationId: op.correlationId,
      rawRequest: op.request as unknown as Record<string, unknown>,
      rawResponse: op.response as unknown as Record<string, unknown>,
    };
  }

  // -------------- internals --------------------------------------

  private async callOperation<TResp>(
    operation: string,
    payload: unknown,
  ): Promise<OperationResult<TResp>> {
    const correlationId = randomUUID();
    const senderCode = this.config.get('NHCX_PARTICIPANT_CODE', { infer: true }) ?? '';
    const gatewayUrl = this.config.get('NHCX_GATEWAY_URL', { infer: true }) ?? '';
    const ourPrivateKey = this.config.get('nhcxPrivateKeyPem', { infer: true });
    const gatewayPublicKey = this.config.get('nhcxGatewayPublicKeyPem', { infer: true });
    const timeoutMs = this.config.get('NHCX_HTTP_TIMEOUT_MS', { infer: true });

    if (!gatewayUrl || !senderCode || !ourPrivateKey || !gatewayPublicKey) {
      throw new Error(
        'NhcxJweAdapter is bound but real-mode config is missing — config loader should reject this earlier.',
      );
    }

    const bundle: NhcxBundle<unknown> = {
      resourceType: 'Bundle',
      type: 'collection',
      meta: {
        timestamp: new Date().toISOString(),
        correlationId,
        senderCode,
        operation,
      },
      payload,
    };
    const encrypted = await encryptToParticipant(bundle, gatewayPublicKey);

    const url = `${gatewayUrl.replace(/\/$/, '')}/${operation}`;
    const started = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/jose',
          accept: 'application/jose',
          [HEADER_CORRELATION]: correlationId,
          [HEADER_SENDER]: senderCode,
          [HEADER_OPERATION]: operation,
        },
        body: encrypted,
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const latencyMs = Date.now() - started;

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.log.warn(
        `nhcx ${operation} → HTTP ${res.status} (${latencyMs}ms) corr=${correlationId} body=${body.slice(0, 200)}`,
      );
      throw new Error(`NHCX ${operation} failed with HTTP ${res.status}`);
    }

    const compactJwe = await res.text();
    const decrypted = await decryptFromParticipant<{ payload: TResp }>(compactJwe, ourPrivateKey);
    this.log.log(
      `nhcx ${operation} ok (${latencyMs}ms) corr=${correlationId}`,
    );
    return {
      correlationId,
      request: bundle,
      response: decrypted.payload,
      latencyMs,
    };
  }
}
