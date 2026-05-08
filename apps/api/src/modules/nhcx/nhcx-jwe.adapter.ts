import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  buildClaimSubmitBundle,
  buildCommunicationBundle,
  buildEligibilityRequestBundle,
  buildPreauthSubmitBundle,
  buildTaskCancelBundle,
  buildTaskReprocessBundle,
  type FhirActorIds,
  type FhirCoverageFields,
  type FhirPatientFields,
} from './fhir-builders';
import {
  type AdapterClaimReprocessInput,
  type AdapterClaimReprocessResult,
  type AdapterClaimSubmitInput,
  type AdapterClaimSubmitResult,
  type AdapterCoverageFields,
  type AdapterDischargeSubmitInput,
  type AdapterEligibilityRequest,
  type AdapterEligibilityResponse,
  type AdapterEnvelopedResult,
  type AdapterPatientFields,
  type AdapterPmjayPolicyLookupInput,
  type AdapterPmjayPolicyLookupResult,
  type AdapterPreauthCancelInput,
  type AdapterPreauthCancelResult,
  type AdapterPreauthQueryRespondInput,
  type AdapterPreauthSubmitInput,
  type AdapterPreauthSubmitResult,
  type NhcxAdapter,
} from './nhcx-adapter.interface';
import {
  NHCX_KEY_RESOLVER,
  type NhcxKeyResolver,
} from './nhcx-key-resolver';
import { decryptFromParticipant, encryptToParticipant, readJweKid } from './nhcx.crypto';
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

  // The key resolver is optional so existing test rigs that build the
  // adapter directly with `new NhcxJweAdapter(cfg)` keep working — the
  // adapter falls back to the legacy single-key behaviour when no
  // resolver is injected.
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    @Optional() @Inject(NHCX_KEY_RESOLVER) private readonly keyResolver: NhcxKeyResolver | null = null,
  ) {}

  async verifyEligibility(input: AdapterEligibilityRequest): Promise<AdapterEligibilityResponse> {
    // Slice T: build a real FHIR CoverageEligibilityRequest bundle
    // when the caller supplied the enriched fields. Otherwise fall
    // back to the lightweight payload so old call sites still work.
    const fhirPayload =
      input.patient && input.coverage
        ? buildEligibilityRequestBundle({
            actors: this.actors(input.coverage.payerCode),
            patient: this.toFhirPatient(input.patient),
            coverage: this.toFhirCoverage(input.coverage),
            serviceDate: input.serviceDate ?? new Date().toISOString().slice(0, 10),
            // Slice BK: PMJAY drives a single-purpose array; legacy
            // private-rail callers omit purpose and get the combined
            // ['benefits','validation'] default from the builder.
            ...(input.purpose ? { purpose: input.purpose } : {}),
          })
        : {
            patientName: input.patientName,
            hospitalMrn: input.hospitalMrn,
            policyNumber: input.policyNumber,
            payerCode: input.payerCode,
            tenantId: input.tenantId,
            claimId: input.claimId,
          };
    const op = await this.callOperation<{
      verified: boolean;
      planName?: string;
      sumInsured?: number;
      failureReason?: string;
    }>('coverage-eligibility/check', fhirPayload);

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
    const fhirPayload =
      input.patient && input.coverage
        ? buildPreauthSubmitBundle({
            actors: this.actors(input.coverage.payerCode),
            patient: this.toFhirPatient(input.patient),
            coverage: this.toFhirCoverage(input.coverage),
            localClaimId: input.claimId,
            ...(input.diagnosisIcdCode !== undefined
              ? { diagnosisIcdCode: input.diagnosisIcdCode }
              : {}),
            ...(input.diagnosisDescription !== undefined
              ? { diagnosisDescription: input.diagnosisDescription }
              : {}),
            ...(input.plannedProcedure !== undefined
              ? { plannedProcedure: input.plannedProcedure }
              : {}),
            ...(input.procedureCode !== undefined
              ? { procedureCode: input.procedureCode }
              : {}),
            ...(input.estimatedLengthOfStayDays !== undefined
              ? { estimatedLengthOfStayDays: input.estimatedLengthOfStayDays }
              : {}),
            ...(input.requestedAmount !== undefined
              ? { requestedAmount: input.requestedAmount }
              : {}),
            ...(input.clinicalJustification !== undefined
              ? { clinicalJustification: input.clinicalJustification }
              : {}),
          })
        : {
            tenantId: input.tenantId,
            claimId: input.claimId,
            requestedAmount: input.requestedAmount,
          };
    const op = await this.callOperation<{
      acknowledged: boolean;
      payerRefNum: string;
    }>('preauth/submit', fhirPayload);
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
    const fhirPayload = input.coverage
      ? buildCommunicationBundle({
          actors: this.actors(input.coverage.payerCode),
          payload: input.responseText,
          ...(input.inReplyToRefNum !== undefined
            ? { inReplyToRefNum: input.inReplyToRefNum }
            : {}),
        })
      : input;
    const op = await this.callOperation('preauth/query/respond', fhirPayload);
    return {
      correlationId: op.correlationId,
      rawRequest: op.request as unknown as Record<string, unknown>,
      rawResponse: op.response as unknown as Record<string, unknown>,
    };
  }

  async submitDischarge(input: AdapterDischargeSubmitInput): Promise<AdapterEnvelopedResult> {
    const fhirPayload = input.coverage
      ? buildCommunicationBundle({
          actors: this.actors(input.coverage.payerCode),
          payload: `discharge documents: ${input.documentIds.join(',')}`,
        })
      : input;
    const op = await this.callOperation('discharge/submit', fhirPayload);
    return {
      correlationId: op.correlationId,
      rawRequest: op.request as unknown as Record<string, unknown>,
      rawResponse: op.response as unknown as Record<string, unknown>,
    };
  }

  async submitClaim(input: AdapterClaimSubmitInput): Promise<AdapterClaimSubmitResult> {
    const fhirPayload =
      input.patient && input.coverage
        ? buildClaimSubmitBundle({
            actors: this.actors(input.coverage.payerCode),
            patient: this.toFhirPatient(input.patient),
            coverage: this.toFhirCoverage(input.coverage),
            localClaimId: input.claimId,
            finalAmount: input.finalAmount,
            documentIds: input.documentIds ?? [],
            ...(input.diagnosisIcdCode !== undefined
              ? { diagnosisIcdCode: input.diagnosisIcdCode }
              : {}),
            ...(input.diagnosisDescription !== undefined
              ? { diagnosisDescription: input.diagnosisDescription }
              : {}),
            ...(input.plannedProcedure !== undefined
              ? { plannedProcedure: input.plannedProcedure }
              : {}),
            ...(input.procedureCode !== undefined
              ? { procedureCode: input.procedureCode }
              : {}),
            ...(input.clinicalJustification !== undefined
              ? { clinicalJustification: input.clinicalJustification }
              : {}),
          })
        : {
            tenantId: input.tenantId,
            claimId: input.claimId,
            finalAmount: input.finalAmount,
          };
    const op = await this.callOperation<{
      acknowledged: boolean;
      claimRefNum: string;
    }>('claim/submit', fhirPayload);
    return {
      acknowledged: op.response.acknowledged,
      claimRefNum: op.response.claimRefNum,
      correlationId: op.correlationId,
      rawRequest: op.request as unknown as Record<string, unknown>,
      rawResponse: op.response as unknown as Record<string, unknown>,
    };
  }

  // Slice BJ — PMJAY beneficiary policies lookup. Plain-REST
  // (NOT JWE-wrapped) per NHCX PMJAY Integration Handbook §5.6.
  // Real-mode is deferred: the upstream gateway URL for
  // `/participant/get/policies` is documented internally but
  // the sandbox/prod base URL hasn't been published in the
  // supporting docs. When the URL lands, swap this for a fetch
  // call carrying `Authorization: Bearer <NHCX session token>`,
  // `X-CM-ID: <env>`, and the documented body shape from the
  // Handbook. Until then the JWE adapter rejects the call so
  // ops can't accidentally promote real-mode and watch every
  // lookup fail; `BIOMETRIC_AUTH_MODE=stub` covers the path for
  // every test + dev today.
  async lookupPmjayPolicies(
    _input: AdapterPmjayPolicyLookupInput,
  ): Promise<AdapterPmjayPolicyLookupResult> {
    throw new Error(
      'PMJAY policies lookup real-mode is not yet implemented — upstream URL pending. Use NHCX_MODE=stub.',
    );
  }

  // Slice BI — outbound `task/submit` with `code: 'reprocess'`
  // for PMJAY claim re-consideration (CRC). The hospital asks the
  // payer to re-evaluate; payer responds later via claim/on_submit.
  async reprocessClaim(input: AdapterClaimReprocessInput): Promise<AdapterClaimReprocessResult> {
    const fhirPayload =
      input.coverage && input.claimRefNum
        ? buildTaskReprocessBundle({
            actors: this.actors(input.coverage.payerCode),
            claimRefNum: input.claimRefNum,
            reasonCode: input.reasonCode,
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
          })
        : {
            tenantId: input.tenantId,
            claimId: input.claimId,
            claimRefNum: input.claimRefNum,
            reasonCode: input.reasonCode,
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
          };
    const op = await this.callOperation<{ acknowledged: boolean }>(
      'task/submit',
      fhirPayload,
    );
    return {
      acknowledged: op.response.acknowledged,
      correlationId: op.correlationId,
      rawRequest: op.request as unknown as Record<string, unknown>,
      rawResponse: op.response as unknown as Record<string, unknown>,
    };
  }

  // Slice BH — outbound `task/submit` for PMJAY preauth cancel.
  // The hospital asserts cancellation; the payer ack arrives later
  // via task/on_submit (Slice BD already records that branch in the
  // ledger).
  async cancelPreauth(input: AdapterPreauthCancelInput): Promise<AdapterPreauthCancelResult> {
    const fhirPayload =
      input.coverage && input.preauthRefNum
        ? buildTaskCancelBundle({
            actors: this.actors(input.coverage.payerCode),
            preauthRefNum: input.preauthRefNum,
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
          })
        : {
            tenantId: input.tenantId,
            claimId: input.claimId,
            preauthRefNum: input.preauthRefNum,
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
          };
    const op = await this.callOperation<{ acknowledged: boolean }>(
      'task/submit',
      fhirPayload,
    );
    return {
      acknowledged: op.response.acknowledged,
      correlationId: op.correlationId,
      rawRequest: op.request as unknown as Record<string, unknown>,
      rawResponse: op.response as unknown as Record<string, unknown>,
    };
  }

  private actors(payerCode: string): FhirActorIds {
    return {
      senderCode: this.config.get('NHCX_PARTICIPANT_CODE', { infer: true }) ?? '',
      receiverCode: payerCode,
    };
  }

  private toFhirPatient(p: AdapterPatientFields): FhirPatientFields {
    return {
      fullName: p.fullName,
      hospitalMrn: p.hospitalMrn,
      ...(p.dateOfBirth !== undefined ? { dateOfBirth: p.dateOfBirth } : {}),
      ...(p.gender !== undefined ? { gender: p.gender } : {}),
      ...(p.abhaId !== undefined ? { abhaId: p.abhaId } : {}),
      ...(p.policyNumber !== undefined ? { policyNumber: p.policyNumber } : {}),
    };
  }

  private toFhirCoverage(c: AdapterCoverageFields): FhirCoverageFields {
    return {
      payerCode: c.payerCode,
      ...(c.payerDisplayName !== undefined ? { payerDisplayName: c.payerDisplayName } : {}),
      memberId: c.memberId,
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
    const gatewayPublicKey = this.config.get('nhcxGatewayPublicKeyPem', { infer: true });
    const timeoutMs = this.config.get('NHCX_HTTP_TIMEOUT_MS', { infer: true });

    // Active outbound key + version. When the resolver is present
    // we honour it (rotation-aware); otherwise fall back to the
    // legacy single-key field for back-compat with existing tests.
    const activeKey = this.keyResolver
      ? this.keyResolver.activePrivateKey()
      : {
          pem: this.config.get('nhcxPrivateKeyPem', { infer: true }) ?? '',
          version: this.config.get('NHCX_PRIVATE_KEY_VERSION', { infer: true }),
        };

    if (!gatewayUrl || !senderCode || !activeKey.pem || !gatewayPublicKey) {
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
    // Stamp our active key version into the JWE header so the gateway
    // knows which of our public keys to verify against. Symmetric
    // operation: the gateway stamps THEIR kid on inbound, and we use
    // it below to pick the right private key.
    const encrypted = await encryptToParticipant(bundle, gatewayPublicKey, activeKey.version);

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
    // Pick the private key matching the inbound JWE's kid. When the
    // gateway hasn't stamped one (legacy / stub gateways) fall through
    // to the active key; that matches Slice P behaviour exactly.
    const inboundKid = readJweKid(compactJwe);
    const decryptKey =
      this.keyResolver && inboundKid
        ? this.keyResolver.privateKeyForVersion(inboundKid) ?? activeKey.pem
        : activeKey.pem;
    const decrypted = await decryptFromParticipant<{ payload: TResp }>(compactJwe, decryptKey);
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
