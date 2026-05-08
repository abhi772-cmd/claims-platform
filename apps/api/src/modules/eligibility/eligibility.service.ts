import { type EligibilityResponse } from '@claims/contracts';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CaseNotFoundError } from '../../common/errors/case-errors';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { type AppConfig } from '../../config/configuration';
import { ClaimService } from '../claim';
import { IntegrationMessageService } from '../integration';
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
export class EligibilityService {
  private readonly log = new Logger(EligibilityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly claims: ClaimService,
    private readonly integration: IntegrationMessageService,
    @Inject(NHCX_ADAPTER) private readonly nhcx: NhcxAdapter,
    private readonly patients: PatientService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly tenants: TenantService,
  ) {}

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
    const patientPii = ctx.patientId
      ? await this.patients.getDecrypted(input.tenantId, ctx.patientId)
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

    // 2. Adapter call.
    const result = await this.nhcx.verifyEligibility(adapterRequest);
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
}
