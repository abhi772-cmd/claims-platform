import { randomUUID } from 'node:crypto';

import { type EligibilityResponse } from '@claims/contracts';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CaseNotFoundError } from '../../common/errors/case-errors';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { type AppConfig } from '../../config/configuration';
import { ClaimService } from '../claim';
import { ConsentService } from '../consent/consent.module';
import {
  classifyAdapterError,
  IntegrationMessageService,
  NhcxReplayWorker,
} from '../integration';
import { type AdapterEligibilityPurpose, NHCX_ADAPTER, type NhcxAdapter } from '../nhcx';
import { PatientService } from '../patient';
import { TenantService } from '../tenant/tenant.service';

export interface RunEligibilityInput {
  tenantId: string;
  caseId: string;
  claimId: string;
  actorUserId: string;
  policyNumber?: string;
  payerCode?: string;
  // Slice BK — PMJAY-via-NHCX runs eligibility three times with
  // different purposes (validation / benefits / auth-requirements).
  // Required for PMJAY tenants; ignored (legacy combined value) on
  // private rails when omitted.
  purpose?: AdapterEligibilityPurpose;
  ip: string | null;
  userAgent: string | null;
}

@Injectable()
export class EligibilityService implements OnApplicationBootstrap {
  private readonly log = new Logger(EligibilityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly claims: ClaimService,
    private readonly integration: IntegrationMessageService,
    @Inject(NHCX_ADAPTER) private readonly nhcx: NhcxAdapter,
    private readonly patients: PatientService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly tenants: TenantService,
    private readonly consents: ConsentService,
    private readonly replay: NhcxReplayWorker,
  ) {}

  // T1-5 — register the replay handler at module bootstrap so the
  // NhcxReplayWorker knows how to retry 'eligibility.verify' rows
  // parked in the queue.
  onApplicationBootstrap(): void {
    this.replay.registerHandler({
      operation: 'eligibility.verify',
      handle: async (ctx) => this.replayQueuedEligibility(ctx),
    });
  }

  // Orchestration:
  //   1. tx-1: read case + claim, transition to ELIGIBILITY_CHECK_PENDING,
  //            write outbound IntegrationMessage row.
  //   2. (no tx) call the adapter — network in real life, in-memory now.
  //   3. tx-2: write inbound IntegrationMessage row + flip outbound to
  //            'succeeded' / 'failed' + transition claim to verified /
  //            failed. The two integration_message writes happen in
  //            IntegrationMessageService.markSucceeded which opens its
  //            own tx; that's fine because the rows are all linked by
  //            correlationId.
  //
  // The adapter call is deliberately OUTSIDE the tx so we don't hold
  // locks across a network round-trip.
  async run(input: RunEligibilityInput): Promise<EligibilityResponse> {
    // Slice BK — PMJAY-via-NHCX dispatches eligibility three times with
    // different purposes. PMJAY tenants must specify which one; we
    // refuse a missing purpose at the gate so it doesn't silently fall
    // through to the private-rail combined ['benefits','validation']
    // default in the FHIR builder. Private rails may still omit
    // purpose and get the legacy behaviour.
    const tenant = await this.tenants.findById(input.tenantId);
    if (tenant?.pmjayMode === 'on' && !input.purpose) {
      throw new ValidationFailedError({
        purpose: [
          'PMJAY eligibility requires a purpose: one of validation, benefits, or auth-requirements.',
        ],
      });
    }

    // 1. Pre-call: load case + claim, validate ownership, transition,
    // record outbound message.
    const ctx = await this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const c = await tx.case.findUnique({
        where: { id: input.caseId },
        include: { claims: { where: { id: input.claimId } } },
      });
      if (!c || c.claims.length === 0) throw new CaseNotFoundError('Case or claim not found.');
      // The state machine accepts eligibility.requested only from
      // INITIATED or ELIGIBILITY_FAILED (retry path) — let
      // ClaimService.transition enforce that.
      return {
        hospitalMrn: c.hospitalMrn,
        patientName: c.patientName,
        patientId: c.patientId,
        admissionDate: c.admissionDate,
      };
    });

    // Pull decrypted PII when the Case has a linked Patient row. We
    // only forward fields the FHIR bundle needs — Aadhaar / mobile /
    // email stay encrypted at rest and never leave the service tier
    // (NHCX uses ABHA id + policy number for identity).
    // Slice CB — best-effort consent lookup so the
    // data_access_event row records the bound grant; same shape as
    // FhirContextService.build (PMJAY tenants → 'pmjay_processing',
    // others → 'nhcx_processing'). Soft enforcement: a missing grant
    // doesn't block the read; the BU dashboard surfaces it.
    let consentGrantId: string | null = null;
    if (ctx.patientId) {
      const consentType = tenant?.pmjayMode === 'on' ? 'pmjay_processing' : 'nhcx_processing';
      const grant = await this.consents.findActiveFor(input.tenantId, ctx.patientId, consentType);
      consentGrantId = grant?.id ?? null;
    }
    const patientPii = ctx.patientId
      ? await this.patients.getDecrypted(input.tenantId, ctx.patientId, {
          actorUserId: input.actorUserId,
          actorType: 'user',
          purpose: 'eligibility.verify',
          consentGrantId,
        })
      : null;

    // The transition itself opens its own tenant tx (ClaimService is
    // self-contained). State-machine errors flow through to the caller
    // unchanged.
    await this.claims.transition({
      tenantId: input.tenantId,
      claimId: input.claimId,
      eventType: 'eligibility.requested',
      actorUserId: input.actorUserId,
      payload: {
        policyNumber: input.policyNumber,
        payerCode: input.payerCode,
        // Slice BK: stamp purpose on the event so the audit trail
        // distinguishes PMJAY's three-purpose dispatch.
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      },
      // Stamp payerCode on the materialised claim so subsequent phase
      // services (preauth, discharge, claim-submit, communication) can
      // build the coverage actor for outbound FHIR Bundles without
      // re-passing it.
      ...(input.payerCode !== undefined ? { patch: { payerCode: input.payerCode } } : {}),
    });

    // Outbound ledger row — separate tx so ClaimService.transition's
    // tx is closed first. Both tied by correlationId once we have it.
    // The adapter generates the correlation id; pre-allocate so the
    // outbound row carries it and the inbound row can match.
    const adapterRequest = {
      tenantId: input.tenantId,
      claimId: input.claimId,
      hospitalMrn: ctx.hospitalMrn,
      patientName: ctx.patientName,
      ...(input.policyNumber !== undefined ? { policyNumber: input.policyNumber } : {}),
      ...(input.payerCode !== undefined ? { payerCode: input.payerCode } : {}),
      // Slice BK: forward purpose to the adapter — the FHIR builder
      // uses it to populate CoverageEligibilityRequest.purpose with a
      // single-element array. Omitting it preserves the legacy
      // combined ['benefits','validation'] default.
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      // Slice T enrichment — feeds the FHIR R4 bundle builder. Stub
      // adapter ignores these fields; the JWE adapter materialises
      // them into a CoverageEligibilityRequest bundle.
      patient: {
        fullName: ctx.patientName,
        hospitalMrn: ctx.hospitalMrn,
        ...(patientPii?.dateOfBirth ? { dateOfBirth: patientPii.dateOfBirth } : {}),
        ...(patientPii?.gender
          ? {
              gender: patientPii.gender as
                | 'male'
                | 'female'
                | 'other'
                | 'prefer_not_to_say',
            }
          : {}),
        ...(patientPii?.abhaId ? { abhaId: patientPii.abhaId } : {}),
        ...(patientPii?.policyNumber ? { policyNumber: patientPii.policyNumber } : {}),
      },
      ...(input.payerCode
        ? {
            coverage: {
              payerCode: input.payerCode,
              memberId:
                input.policyNumber ??
                patientPii?.policyNumber ??
                ctx.hospitalMrn,
            },
            serviceDate: ctx.admissionDate.toISOString().slice(0, 10),
          }
        : {}),
    };

    // 2. Adapter call. Wrapped in classify-and-park (T1-5): a
    // transient error (network / 5xx / timeout) parks an outbound
    // row at status='queued_for_retry' so the NhcxReplayWorker
    // re-issues the call once the gateway recovers. The claim stays
    // at ELIGIBILITY_CHECK_PENDING in the meantime — the operator
    // sees a "queued" pill rather than a hard failure.
    //
    // A permanent error (4xx / JWE decrypt / unknown shape) flows
    // up unchanged; the existing ValidationFailedError /
    // domain-error path applies.
    let result;
    try {
      result = await this.nhcx.verifyEligibility(adapterRequest);
    } catch (err) {
      const classified = classifyAdapterError(err);
      if (classified.classification === 'transient') {
        return this.parkForReplay({
          tenantId: input.tenantId,
          claimId: input.claimId,
          adapterRequest,
          failureClass: classified.failureClass,
          message: classified.message,
        });
      }
      throw err;
    }
    const correlationId = result.correlationId;

    // Outbound row (we couldn't write it before the call because we
    // didn't have correlationId yet — the real adapter will produce
    // it locally before the network hop, fix in Slice P). For now we
    // record both directions atomically here.
    const outboundId = await this.prisma.runInTenantContext(
      input.tenantId,
      'tenant',
      async (tx) => {
        const row = await this.integration.recordOutboundWithTx(tx, {
          tenantId: input.tenantId,
          claimId: input.claimId,
          integration: 'nhcx',
          operation: 'eligibility.verify',
          correlationId,
          rawRequest: adapterRequest,
        });
        return row.id;
      },
    );

    // Slice AC: real-mode = the gateway will POST a CoverageEligibility
    // Response to /nhcx/inbound; that webhook handler runs the
    // verified/failed transition. In real mode we skip both the
    // synthetic inbound row and the auto-transition here so the
    // dispatcher doesn't hit a duplicate-transition. The claim sits at
    // ELIGIBILITY_CHECK_PENDING until the callback arrives.
    //
    // Stub mode keeps the existing behaviour because no real callback
    // ever fires — the orchestrator IS the simulated gateway.
    if (this.config.get('NHCX_MODE', { infer: true }) === 'real') {
      const pendingSnap = await this.prisma.runInTenantContext(
        input.tenantId,
        'platform_admin',
        async (tx) => {
          // Outbound row stays at status='pending' — it'll be flipped
          // to 'succeeded'/'failed' when the inbound dispatcher pairs
          // a callback with this correlationId. No state change here.
          return tx.claim.findUniqueOrThrow({ where: { id: input.claimId } });
        },
      );
      this.log.log(
        `eligibility submitted (real mode) claimId=${input.claimId} correlationId=${correlationId} — awaiting gateway callback`,
      );
      return {
        verified: false,
        correlationId,
        status: pendingSnap.status,
      };
    }

    // 3. Mark outbound succeeded + write inbound row + transition claim.
    if (result.verified) {
      await this.integration.markSucceeded({
        tenantId: input.tenantId,
        outboundId,
        correlationId,
        integration: 'nhcx',
        operation: 'eligibility.verify',
        claimId: input.claimId,
        rawResponse: result.rawResponse,
      });
      const snap = await this.claims.transition({
        tenantId: input.tenantId,
        claimId: input.claimId,
        eventType: 'eligibility.verified',
        actorUserId: input.actorUserId,
        correlationId,
        payload: { planName: result.planName, sumInsured: result.sumInsured },
      });
      this.log.log(`eligibility verified claimId=${input.claimId}`);
      return {
        verified: true,
        ...(result.planName !== undefined ? { planName: result.planName } : {}),
        ...(result.sumInsured !== undefined ? { sumInsured: result.sumInsured } : {}),
        correlationId,
        status: snap.status,
      };
    }

    // Failed — record failure + transition to ELIGIBILITY_FAILED. We
    // treat the adapter's "verified=false" as a SUCCESSFUL call that
    // returned a negative result (status='succeeded'); a 'failed'
    // ledger row is reserved for transport-level errors. Sprint 3
    // backlog item: separate `result_status` from `delivery_status`.
    await this.integration.markSucceeded({
      tenantId: input.tenantId,
      outboundId,
      correlationId,
      integration: 'nhcx',
      operation: 'eligibility.verify',
      claimId: input.claimId,
      rawResponse: result.rawResponse,
    });
    const snap = await this.claims.transition({
      tenantId: input.tenantId,
      claimId: input.claimId,
      eventType: 'eligibility.failed',
      actorUserId: input.actorUserId,
      correlationId,
      payload: { failureReason: result.failureReason },
    });
    return {
      verified: false,
      ...(result.failureReason !== undefined ? { failureReason: result.failureReason } : {}),
      correlationId,
      status: snap.status,
    };
  }

  // Slice Z entry point. Called by the NHCX inbound dispatcher when a
  // CoverageEligibilityResponse arrives via webhook. The outbound
  // integration_message + initial transition (ELIGIBILITY_CHECK_PENDING)
  // already happened during run(); here we only flip the claim to
  // verified or failed, mirroring the second-tx logic from run().
  //
  // No actorUserId: the inbound dispatcher acts as the platform on
  // behalf of the gateway. State-machine transitions accept null actor.
  async handleInboundResponse(input: {
    tenantId: string;
    claimId: string;
    correlationId: string;
    parsed: { verified: boolean; planName?: string; sumInsured?: number; failureReason?: string };
  }): Promise<{ status: string }> {
    const eventType = input.parsed.verified ? 'eligibility.verified' : 'eligibility.failed';
    const payload: Record<string, unknown> = {};
    if (input.parsed.verified) {
      if (input.parsed.planName !== undefined) payload['planName'] = input.parsed.planName;
      if (input.parsed.sumInsured !== undefined) payload['sumInsured'] = input.parsed.sumInsured;
    } else if (input.parsed.failureReason !== undefined) {
      payload['failureReason'] = input.parsed.failureReason;
    }
    const snap = await this.claims.transition({
      tenantId: input.tenantId,
      claimId: input.claimId,
      eventType,
      actorUserId: null,
      correlationId: input.correlationId,
      payload,
    });
    this.log.log(
      `eligibility ${input.parsed.verified ? 'verified' : 'failed'} via inbound claimId=${input.claimId} correlationId=${input.correlationId}`,
    );
    return { status: snap.status };
  }

  // T1-5 — park a transient-failed eligibility for the replay queue.
  // The outbound row is written here with a server-generated
  // correlationId so retries can be matched on the gateway side.
  // Claim stays at ELIGIBILITY_CHECK_PENDING; the response shape
  // mirrors the real-mode "awaiting callback" path so the UI sees
  // the same waiting state for either situation.
  private async parkForReplay(input: {
    tenantId: string;
    claimId: string;
    adapterRequest: unknown;
    failureClass:
      | 'network'
      | 'timeout'
      | 'server_5xx'
      | 'auth'
      | 'validation'
      | 'captcha'
      | 'selector'
      | 'unknown';
    message: string;
  }): Promise<EligibilityResponse> {
    const correlationId = randomUUID();
    const outboundId = await this.prisma.runInTenantContext(
      input.tenantId,
      'tenant',
      async (tx) => {
        const row = await this.integration.recordOutboundWithTx(tx, {
          tenantId: input.tenantId,
          claimId: input.claimId,
          integration: 'nhcx',
          operation: 'eligibility.verify',
          correlationId,
          rawRequest: input.adapterRequest,
        });
        return row.id;
      },
    );
    await this.integration.markQueuedForRetry({
      tenantId: input.tenantId,
      outboundId,
      failureClass: input.failureClass,
      attemptsSoFar: 0,
    });
    this.log.warn(
      `eligibility queued for replay claimId=${input.claimId} correlationId=${correlationId} reason=${input.message}`,
    );
    const pendingSnap = await this.prisma.runInTenantContext(
      input.tenantId,
      'platform_admin',
      async (tx) => tx.claim.findUniqueOrThrow({ where: { id: input.claimId } }),
    );
    return {
      verified: false,
      correlationId,
      status: pendingSnap.status,
    };
  }

  // T1-5 — replay handler invoked by NhcxReplayWorker on tick.
  //
  // The strategy here is deliberately conservative: we re-issue the
  // adapter call ONLY if the claim is still at ELIGIBILITY_CHECK_PENDING.
  // If the operator (or the inbound dispatcher) has already moved the
  // claim forward, the replay is a no-op and we mark the row succeeded
  // so the worker stops re-parking it.
  //
  // Successful replay marks the outbound row succeeded and drives the
  // eligibility.verified / eligibility.failed transition. The adapter
  // call uses a NEW correlationId — the gateway treats the retry as a
  // fresh request. The original parked row holds the prior id for
  // forensic correlation.
  private async replayQueuedEligibility(ctx: {
    outboundId: string;
    tenantId: string;
    claimId: string | null;
    correlationId: string;
  }): Promise<'succeeded' | 'transient' | 'permanent'> {
    if (!ctx.claimId) return 'permanent';

    // Re-derive the request from current persistent state. Claim row
    // carries payerCode; case carries patient name + mrn; patient row
    // carries decrypted PII. If any of these are missing, treat as
    // permanent and let ops triage.
    const ctxRow = await this.prisma.runInTenantContext(ctx.tenantId, 'tenant', async (tx) => {
      const c = await tx.claim.findUnique({ where: { id: ctx.claimId! } });
      if (!c) return null;
      // Only retry if the claim is still waiting on the eligibility
      // round-trip. Anything else (verified, failed, moved on) means
      // the operator already acted.
      if (c.status !== 'ELIGIBILITY_CHECK_PENDING') {
        return { skip: true as const, status: c.status };
      }
      const cs = await tx.case.findUnique({ where: { id: c.caseId } });
      if (!cs) return null;
      return {
        skip: false as const,
        claim: c,
        case: cs,
      };
    });
    if (ctxRow === null) return 'permanent';
    if (ctxRow.skip) {
      await this.integration.markReplayExhausted({
        tenantId: ctx.tenantId,
        outboundId: ctx.outboundId,
        failureClass: 'unknown',
      });
      this.log.log(
        `eligibility replay skipped (claim already at ${ctxRow.status}) outboundId=${ctx.outboundId}`,
      );
      return 'succeeded';
    }

    const adapterRequest = {
      tenantId: ctx.tenantId,
      claimId: ctx.claimId,
      hospitalMrn: ctxRow.case.hospitalMrn,
      patientName: ctxRow.case.patientName,
      ...(ctxRow.claim.payerCode !== null ? { payerCode: ctxRow.claim.payerCode } : {}),
    };

    let result;
    try {
      result = await this.nhcx.verifyEligibility(adapterRequest);
    } catch (err) {
      const classified = classifyAdapterError(err);
      return classified.classification === 'transient' ? 'transient' : 'permanent';
    }

    await this.integration.markReplaySucceeded({
      tenantId: ctx.tenantId,
      outboundId: ctx.outboundId,
      correlationId: result.correlationId,
      integration: 'nhcx',
      operation: 'eligibility.verify',
      claimId: ctx.claimId,
      rawResponse: result.rawResponse,
    });
    await this.claims.transition({
      tenantId: ctx.tenantId,
      claimId: ctx.claimId,
      eventType: result.verified ? 'eligibility.verified' : 'eligibility.failed',
      actorUserId: null,
      correlationId: result.correlationId,
      payload: result.verified
        ? { planName: result.planName, sumInsured: result.sumInsured }
        : { failureReason: result.failureReason },
    });
    this.log.log(
      `eligibility replay succeeded claimId=${ctx.claimId} verified=${result.verified} correlationId=${result.correlationId}`,
    );
    return 'succeeded';
  }
}
