import { type EligibilityResponse } from '@claims/contracts';
import { Injectable, Logger } from '@nestjs/common';

import { NhcxStubAdapter } from './nhcx-stub.adapter';
import { CaseNotFoundError } from '../../common/errors/case-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ClaimService } from '../claim';
import { IntegrationMessageService } from '../integration';

export interface RunEligibilityInput {
  tenantId: string;
  caseId: string;
  claimId: string;
  actorUserId: string;
  policyNumber?: string;
  payerCode?: string;
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
    private readonly nhcx: NhcxStubAdapter,
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
      return { hospitalMrn: c.hospitalMrn, patientName: c.patientName };
    });

    // The transition itself opens its own tenant tx (ClaimService is
    // self-contained). State-machine errors flow through to the caller
    // unchanged.
    await this.claims.transition({
      tenantId: input.tenantId,
      claimId: input.claimId,
      eventType: 'eligibility.requested',
      actorUserId: input.actorUserId,
      payload: { policyNumber: input.policyNumber, payerCode: input.payerCode },
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
}
