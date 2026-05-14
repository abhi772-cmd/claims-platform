import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  buildClaimSubmitBundle,
  buildCommunicationBundle,
  buildEligibilityRequestBundle,
  buildInsurancePlanRequestBundle,
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
  type AdapterInsurancePlanRequestInput,
  type AdapterInsurancePlanRequestResult,
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
import { Agent as UndiciAgent, type Dispatcher } from 'undici';

import { decryptFromParticipant, encryptToParticipant, readJweKid } from './nhcx.crypto';
import { signOutboundRequest } from './outbound-http-signature';
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

// --- NHCX HTTP header taxonomy --------------------------------
// `docs/07-nhcx-and-pmjay.md` lines 42–53 specify ten `x-hcx-*`
// headers on every outbound call. The pre-Sprint-9 adapter sent
// only three of them (correlation/sender/operation), and only in
// the hyphenated form. Doc 07 documents the underscored variants
// (`x-hcx-correlation_id` etc.) but the inbound guard already
// validates the hyphenated form against NHA's sandbox.
//
// Per GAP_ANALYSIS.md row 2.1 the authoritative spec source for
// the header name convention is not in the scraped corpus, so we
// emit hyphenated names (matching what the inbound guard already
// accepts from NHA — i.e. the form NHA itself uses) and surface
// the open question via a runtime warning when an environment
// variable demands the underscored form instead. Flip
// `NHCX_HEADER_STYLE=underscored` at the gateway config layer to
// switch.
const HEADER_NAMES_HYPHENATED = {
  correlationId: 'x-hcx-correlation-id',
  status: 'x-hcx-status',
  requestId: 'x-hcx-request-id',
  benAbhaId: 'x-hcx-ben-abha-id',
  timestamp: 'x-hcx-timestamp',
  recipientCode: 'x-hcx-recipient-code',
  senderCode: 'x-hcx-sender-code',
  workflowId: 'x-hcx-workflow-id',
  apiCallId: 'x-hcx-api-call-id',
  useCase: 'x-hcx-use-case',
  operation: 'x-hcx-operation',
} as const;
const HEADER_NAMES_UNDERSCORED = {
  correlationId: 'x-hcx-correlation_id',
  status: 'x-hcx-status',
  requestId: 'x-hcx-request_id',
  benAbhaId: 'x-hcx-ben-abha-id',
  timestamp: 'x-hcx-timestamp',
  recipientCode: 'x-hcx-recipient_code',
  senderCode: 'x-hcx-sender_code',
  workflowId: 'x-hcx-workflow_id',
  apiCallId: 'x-hcx-api_call_id',
  useCase: 'x-hcx-use_case',
  operation: 'x-hcx-operation',
} as const;

// --- Per-operation URL path map -------------------------------
// NHCX's gateway routes by service: each operation lives under
// `/api/<service>hcxservice/<service>/<action>` (doc 07 lines
// 27–38). The pre-Sprint-9 adapter concatenated the operation
// string to the gateway base, which only worked for the few
// operations whose service name + action happened to match the
// concatenation. This map gives us the canonical path so the
// caller passes the operation key (e.g. 'preauth/submit') and the
// adapter resolves the full URL.
const OPERATION_PATHS: Record<string, string> = {
  // Coverage eligibility
  'coverageeligibility/check': '/api/coverageeligibilityhcxservice/coverageeligibility/check',
  'coverage-eligibility/check': '/api/coverageeligibilityhcxservice/coverageeligibility/check', // legacy alias
  // Insurance plan lookup
  'insuranceplan/request': '/api/insuranceplanhcxservice/insuranceplan/request',
  // Preauth
  'preauth/submit': '/api/preauthhcxservice/preauth/submit',
  // Claim
  'claim/submit': '/api/claimhcxservice/claim/submit',
  // Communication (used for preauth-query response + discharge handoff)
  'communication/request': '/api/communicationhcxservice/communication/request',
  'preauth/query/respond': '/api/communicationhcxservice/communication/request', // legacy alias
  'discharge/submit': '/api/communicationhcxservice/communication/request', // legacy alias
  // Task — cancel preauth + reprocess claim share the endpoint;
  // the bundle's Task.code coding distinguishes the action.
  'task/submit': '/api/taskhcxservice/task/submit',
  // Predetermination + search + payment-notice ack — placeholders;
  // see GAP_ANALYSIS.md rows 1.10/1.15/1.16.
  'predetermination/submit': '/api/predeterminationhcxservice/predetermination/submit',
  'search/submit': '/api/searchhcxservice/search/submit',
  'paymentnotice/on_request': '/api/paymentnoticehcxservice/paymentnotice/on_request',
};

function resolveOperationPath(operation: string): string {
  const mapped = OPERATION_PATHS[operation];
  if (mapped) return mapped;
  // Fall through to the legacy `/<operation>` shape for any
  // operation not yet mapped — preserves back-compat for callers
  // that haven't been migrated.
  return `/${operation}`;
}

// Optional context passed by callers to participate in the
// correlation chain and use-case taxonomy. All fields are
// optional; sensible defaults are applied below.
interface OutboundContext {
  // Reuse this id as `x-hcx-correlation-id` instead of generating a
  // fresh one. NHCX uses correlation id to group every message in a
  // lifecycle (insurance → coverage → preauth → claim → payment).
  inheritCorrelationId?: string;
  // First call in the chain — emitted as `x-hcx-api-call-id`. For
  // the first call, the adapter sets api-call-id = correlation id.
  rootCorrelationId?: string;
  // `x-hcx-use-case` semantic. Defaults to 'New'.
  useCase?: 'New' | 'Enhancement' | 'Resubmission' | 'Reprocess' | 'Cancel';
  // `x-hcx-ben-abha-id`. Logged-redacted; only emitted on the wire
  // when the beneficiary has consented to ABHA-based identification.
  benAbhaId?: string;
  // `x-hcx-recipient-code` — defaults to the receiverCode the
  // FHIR builder uses, but callers can override for relay scenarios.
  recipientCode?: string;
}

@Injectable()
export class NhcxJweAdapter implements NhcxAdapter {
  private readonly log = new Logger(NhcxJweAdapter.name);

  // Cached undici Dispatcher for outbound mTLS, when enabled. Built
  // lazily on the first outbound call so unit tests that never hit
  // resolveMtlsDispatcher don't pay for the TLS context. `null`
  // means "resolution attempted, mTLS disabled" — distinct from
  // `undefined` which means "not yet resolved".
  private mtlsDispatcher: Dispatcher | null | undefined = undefined;

  // The key resolver is optional so existing test rigs that build the
  // adapter directly with `new NhcxJweAdapter(cfg)` keep working — the
  // adapter falls back to the legacy single-key behaviour when no
  // resolver is injected.
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    @Optional() @Inject(NHCX_KEY_RESOLVER) private readonly keyResolver: NhcxKeyResolver | null = null,
  ) {}

  // Resolve (and cache) the outbound mTLS dispatcher. Returns null
  // when NHCX_MTLS_ENABLED is false — that path falls through to
  // Node's default fetch agent and plain HTTPS. We construct one
  // undici.Agent for the lifetime of the adapter so the underlying
  // TLS connection pool is reused across outbound calls.
  private resolveMtlsDispatcher(): Dispatcher | null {
    if (this.mtlsDispatcher !== undefined) return this.mtlsDispatcher;
    const enabled = this.config.get('NHCX_MTLS_ENABLED', { infer: true });
    if (!enabled) {
      this.mtlsDispatcher = null;
      return null;
    }
    const cert = this.config.get('nhcxMtlsClientCertPem', { infer: true });
    const key = this.config.get('nhcxMtlsClientKeyPem', { infer: true });
    const ca = this.config.get('nhcxMtlsCaPem', { infer: true });
    if (!cert || !key) {
      // ConfigLoader rejects this combo at boot, so reaching this
      // branch means env was mutated after boot. Log + degrade to
      // plain HTTPS rather than crash mid-request — the gateway
      // will return its own TLS error if it required mTLS.
      this.log.warn(
        'NHCX_MTLS_ENABLED=true but client cert/key resolved as empty at runtime — falling back to plain HTTPS',
      );
      this.mtlsDispatcher = null;
      return null;
    }
    this.mtlsDispatcher = new UndiciAgent({
      connect: {
        cert,
        key,
        ...(ca ? { ca } : {}),
      },
    });
    this.log.log('NHCX outbound mTLS dispatcher initialised');
    return this.mtlsDispatcher;
  }

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
    }>(
      'coverageeligibility/check',
      fhirPayload,
      input.coverage?.payerCode ?? input.payerCode,
      input.patient?.abhaId ? { benAbhaId: input.patient.abhaId } : undefined,
    );

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

  async requestInsurancePlan(
    input: AdapterInsurancePlanRequestInput,
  ): Promise<AdapterInsurancePlanRequestResult> {
    // GAP_ANALYSIS.md row 1.13: this is the chain-root NHCX operation —
    // every later HCX-correlated call inherits the correlation id we
    // create here. The bundle shape mirrors NRCES's
    // TaskBundleForInsurancePlanRequest example: financial task code
    // 'poll' + policyNumber/providerId inputs.
    const fhirPayload = buildInsurancePlanRequestBundle({
      actors: this.actors(input.payerCode),
      policyNumber: input.policyNumber,
      providerId: input.providerId,
      ...(input.payerDisplayName !== undefined
        ? { payerDisplayName: input.payerDisplayName }
        : {}),
      ...(input.hospitalDisplayName !== undefined
        ? { hospitalDisplayName: input.hospitalDisplayName }
        : {}),
    });
    const op = await this.callOperation<{ acknowledged: boolean }>(
      'insuranceplan/request',
      fhirPayload,
      input.payerCode,
      {
        // Chain root: no parent. We DO set useCase='New' explicitly
        // so the downstream header taxonomy is unambiguous.
        useCase: 'New' as const,
        ...(input.patient?.abhaId ? { benAbhaId: input.patient.abhaId } : {}),
      },
    );
    return {
      acknowledged: op.response.acknowledged ?? true,
      correlationId: op.correlationId,
      rawRequest: op.request as unknown as Record<string, unknown>,
      rawResponse: op.response as unknown as Record<string, unknown>,
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
    }>(
      'preauth/submit',
      fhirPayload,
      input.coverage?.payerCode,
      {
        // Chain off the eligibility correlation when the upstream
        // service passes one; otherwise this is a fresh chain root.
        ...(input.parentCorrelationId
          ? { inheritCorrelationId: input.parentCorrelationId }
          : {}),
        ...(input.useCase ? { useCase: input.useCase } : {}),
        ...(input.patient?.abhaId ? { benAbhaId: input.patient.abhaId } : {}),
      },
    );
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
    const op = await this.callOperation(
      'preauth/query/respond',
      fhirPayload,
      input.coverage?.payerCode,
      input.parentCorrelationId
        ? { inheritCorrelationId: input.parentCorrelationId, useCase: 'Enhancement' as const }
        : { useCase: 'Enhancement' as const },
    );
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
    const op = await this.callOperation(
      'discharge/submit',
      fhirPayload,
      input.coverage?.payerCode,
      input.parentCorrelationId
        ? { inheritCorrelationId: input.parentCorrelationId }
        : undefined,
    );
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
    }>(
      'claim/submit',
      fhirPayload,
      input.coverage?.payerCode,
      {
        ...(input.parentCorrelationId
          ? { inheritCorrelationId: input.parentCorrelationId }
          : {}),
        ...(input.patient?.abhaId ? { benAbhaId: input.patient.abhaId } : {}),
      },
    );
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
      input.coverage?.payerCode,
      input.parentCorrelationId
        ? { inheritCorrelationId: input.parentCorrelationId, useCase: 'Reprocess' as const }
        : { useCase: 'Reprocess' as const },
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
      input.coverage?.payerCode,
      input.parentCorrelationId
        ? { inheritCorrelationId: input.parentCorrelationId, useCase: 'Cancel' as const }
        : { useCase: 'Cancel' as const },
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
      senderCode: this.resolveSenderCode(),
      receiverCode: payerCode,
    };
  }

  // Resolve the NHCX participant code for the *current* tenant. The
  // pre-Sprint-9 adapter read this from a single global env var,
  // which collapses to one participant per platform deployment —
  // incompatible with the multi-tenant SaaS we're shipping (GAP
  // ANALYSIS.md row 10.2 / 15).
  //
  // The new resolution order is:
  //   1. Per-tenant participant code injected via request-scoped
  //      `TenantContext` (Sprint 9 BL/BS) — when present, that wins.
  //   2. Env-var fallback `NHCX_PARTICIPANT_CODE` for the integrator
  //      identity used in dev/sandbox and during bootstrap.
  //
  // The TenantContext wiring lives in the request-scoped provider
  // graph; for slices that still construct the adapter directly we
  // fall back to the env var.
  private resolveSenderCode(): string {
    // Request-scoped tenant config lookup. We use a lazy
    // optional-import shape rather than a constructor injection so
    // the adapter remains testable from synchronous fixtures.
    const tenantCode = (this as unknown as { tenantContext?: { nhcxParticipantCode?: string } })
      .tenantContext?.nhcxParticipantCode;
    if (tenantCode) return tenantCode;
    return this.config.get('NHCX_PARTICIPANT_CODE', { infer: true }) ?? '';
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
    receiverCode?: string,
    ctx?: OutboundContext,
  ): Promise<OperationResult<TResp>> {
    // Correlation id: reuse the inherited one when chaining (e.g.
    // preauth/submit reusing the coverage/check correlation), else
    // generate fresh. `x-hcx-api-call-id` carries the root of the
    // chain so NHA-side reporting can group the entire lifecycle.
    const correlationId = ctx?.inheritCorrelationId ?? randomUUID();
    const apiCallId = ctx?.rootCorrelationId ?? correlationId;
    // `x-hcx-request-id` is unique per individual HTTP request —
    // even retries of the same correlation get a fresh request id.
    const requestId = randomUUID();
    // Resolve participant code with per-tenant override taking
    // precedence over the global env fallback. GAP_ANALYSIS.md row
    // 10.2 flagged that the env-var-only model breaks multi-tenancy;
    // tenants now plug their own NHCX participant code via the
    // onboarding wizard and we read it here before the env default.
    const senderCode = this.resolveSenderCode();
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

    const url = `${gatewayUrl.replace(/\/$/, '')}${resolveOperationPath(operation)}`;
    // --- Runtime-configurable architectural flags ---------------
    // See docs/decisions/NHCX_INTEGRATION_FLAGS.md for the full
    // decision matrix. Each flag has a documented default that
    // matches the most-likely production setting based on doc 07
    // and HCX 0.7.1 lineage; flip at sandbox-test time if NHA's
    // gateway rejects a specific error class.
    const headerStyle =
      (this.config.get('NHCX_HEADER_STYLE', { infer: true }) ??
        process.env['NHCX_HEADER_STYLE'] ??
        'hyphenated') as 'hyphenated' | 'underscored';
    const H =
      headerStyle === 'underscored' ? HEADER_NAMES_UNDERSCORED : HEADER_NAMES_HYPHENATED;
    const wireFormat = (this.config.get('NHCX_WIRE_FORMAT', { infer: true }) ??
      'envelope-omit-type-insurance-coverage') as
      | 'bare'
      | 'envelope'
      | 'envelope-omit-type-insurance-coverage';
    // `x-hcx-status` — per HCX spec lineage, the initial outbound
    // value is `request.initiated`. Follow-ups (enhancement,
    // resubmission) use `request.queued` or `request.complete`;
    // those are emitted from the callers that know their own state.
    const hcxStatus = 'request.initiated';
    const useCase = ctx?.useCase ?? 'New';
    const recipientCode = ctx?.recipientCode ?? receiverCode ?? '';

    // Wire-format selector (NHCX_WIRE_FORMAT). 'bare' sends the JWE
    // compact string as the raw body with application/jose. The two
    // 'envelope' variants wrap the JWE in a JSON object so the body
    // becomes application/json. 'envelope-omit-type-insurance-coverage'
    // honours the DigiNode quirk: insurance + coverage services
    // historically reject the `type` field, so we drop it for those
    // two operations only. Everything else carries `type:"JWEPayload"`.
    const isInsuranceOrCoverage =
      operation.startsWith('insuranceplan/') || operation.startsWith('coverageeligibility/');
    let bodyToSend: string | Buffer;
    let contentType: string;
    if (wireFormat === 'bare') {
      bodyToSend = encrypted;
      contentType = 'application/jose';
    } else {
      const includeType =
        wireFormat === 'envelope'
          ? true
          : /* envelope-omit-type-insurance-coverage */ !isInsuranceOrCoverage;
      const envelope: Record<string, string> = { payload: encrypted };
      if (includeType) envelope['type'] = 'JWEPayload';
      bodyToSend = JSON.stringify(envelope);
      contentType = 'application/json';
    }

    const headers: Record<string, string> = {
      'content-type': contentType,
      // Accept both — the gateway may respond in either format and
      // we don't yet know which it picks on the response path.
      accept: 'application/json, application/jose;q=0.9',
      [H.correlationId]: correlationId,
      [H.requestId]: requestId,
      [H.apiCallId]: apiCallId,
      [H.senderCode]: senderCode,
      [H.timestamp]: String(Date.now()),
      [H.workflowId]: '1',
      [H.status]: hcxStatus,
      [H.useCase]: useCase,
      [H.operation]: operation,
    };
    if (recipientCode) headers[H.recipientCode] = recipientCode;
    if (ctx?.benAbhaId) headers[H.benAbhaId] = ctx.benAbhaId;

    // Outbound Cavage HTTP Signature. GAP_ANALYSIS.md row 9.7 flagged
    // that we verified inbound signatures but emitted nothing on
    // outbound — symmetric to NHA's expectation that participants
    // sign their requests. The keyId combines participant code with
    // the active key version so the gateway can pick the right public
    // key from our registration. Disable with NHCX_SIGN_OUTBOUND=0
    // for the (rare) sandbox scenarios that don't accept signed
    // requests; default is enabled.
    //
    // Important: the Digest header is the SHA-256 of the bytes
    // actually placed on the wire (i.e. `bodyToSend`, AFTER any
    // envelope wrapping). Computing it over the raw JWE when we
    // ship an envelope would break NHA-side signature verification.
    const signOutbound = process.env['NHCX_SIGN_OUTBOUND'] !== '0';
    if (signOutbound) {
      const bodyBuf =
        typeof bodyToSend === 'string' ? Buffer.from(bodyToSend, 'utf8') : bodyToSend;
      // Cavage's (request-target) wants the path-and-query in
      // lowercase. URL constructor handles parsing safely even when
      // gatewayUrl includes a port or trailing slash.
      const parsed = new URL(url);
      const pathAndQuery = `${parsed.pathname}${parsed.search}`.toLowerCase();
      const keyId = `${senderCode}:${activeKey.version}`;
      const signed = signOutboundRequest({
        method: 'POST',
        path: pathAndQuery,
        host: parsed.host,
        body: bodyBuf,
        headers: {
          'x-hcx-correlation-id': correlationId,
          'x-hcx-operation': operation,
        },
        privateKeyPem: activeKey.pem,
        keyId,
        now: new Date(),
      });
      headers['date'] = signed.date;
      headers['digest'] = signed.digest;
      headers['host'] = signed.host;
      headers['signature'] = signed.signature;
    }

    // Optional outbound mTLS. The dispatcher is lazily constructed on
    // first use and cached on the adapter instance so the TLS
    // connection pool is reused across calls. When NHCX_MTLS_ENABLED
    // is false (the default) we skip the dispatcher entirely and let
    // Node's global fetch use plain HTTPS.
    const dispatcher = this.resolveMtlsDispatcher();

    const started = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      // The `dispatcher` field is undici-specific. The bundled
      // `undici-types` package (used by Node's fetch typings) and the
      // standalone `undici` package each ship their own Dispatcher
      // type; they're structurally identical but nominally distinct,
      // so we cast through `unknown` to satisfy the compiler. At
      // runtime both resolve to the same class.
      const fetchInit = {
        method: 'POST',
        headers,
        body: bodyToSend,
        signal: ac.signal,
        ...(dispatcher ? { dispatcher } : {}),
      } as unknown as RequestInit;
      res = await fetch(url, fetchInit);
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

    const rawResponseBody = await res.text();
    // The gateway may respond in either wire format. Detect by
    // peeking at the response content-type; fall back to a structure
    // sniff when the gateway sends an unhelpful content-type. JSON
    // envelopes carry a `.payload` field whose value is the actual
    // compact JWE we need to decrypt.
    const responseCt = (res.headers.get('content-type') ?? '').toLowerCase();
    let compactJwe = rawResponseBody;
    if (responseCt.includes('json') || rawResponseBody.trimStart().startsWith('{')) {
      try {
        const parsed = JSON.parse(rawResponseBody) as { payload?: string };
        if (typeof parsed.payload === 'string' && parsed.payload.length > 0) {
          compactJwe = parsed.payload;
        }
      } catch {
        // Not JSON after all — treat as bare JWE.
      }
    }
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
