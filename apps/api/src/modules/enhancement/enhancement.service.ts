// T2-8 — preauth enhancement.
//
// Lean MVP that drives the existing ENHANCEMENT_DRAFTING → ENHANCEMENT_QUEUED
// → ENHANCEMENT_SUBMITTED state machine (already defined in
// apps/api/src/modules/claim/claim.state-machine.ts). Two operator-driven
// entry points:
//
//   start()  — claim at PREAUTH_APPROVED / PREAUTH_PARTIALLY_APPROVED →
//              ENHANCEMENT_DRAFTING. Just a state flip; no adapter call.
//   submit() — claim at ENHANCEMENT_DRAFTING → ENHANCEMENT_QUEUED, calls
//              adapter.submitEnhancement, on ack → ENHANCEMENT_SUBMITTED.
//
// The replay-queue / FHIR-context wiring that preauth.service.ts has
// is deliberately omitted here for MVP — the stub adapter doesn't
// throw, and the real-mode adapter explicitly returns a "not yet
// implemented" error. When real-mode lands, this service can layer
// classifyAdapterError + parkForReplay on top in the same shape as
// the existing services.

import {
  type EnhancementResponse,
} from '@claims/contracts';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { ClaimNotFoundError } from '../../common/errors/claim-errors';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ClaimService } from '../claim';
import { IntegrationMessageService } from '../integration';
import { NHCX_ADAPTER, type NhcxAdapter } from '../nhcx';

export interface StartEnhancementInput {
  tenantId: string;
  claimId: string;
  actorUserId: string;
}

export interface SubmitEnhancementInput {
  tenantId: string;
  claimId: string;
  actorUserId: string;
  revisedAmount: number;
  reason: string;
}

@Injectable()
export class EnhancementService {
  private readonly log = new Logger(EnhancementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly claims: ClaimService,
    private readonly integration: IntegrationMessageService,
    @Inject(NHCX_ADAPTER) private readonly nhcx: NhcxAdapter,
  ) {}

  async start(input: StartEnhancementInput): Promise<EnhancementResponse> {
    const out = await this.claims.transition({
      tenantId: input.tenantId,
      claimId: input.claimId,
      eventType: 'enhancement.drafting_started',
      actorUserId: input.actorUserId,
    });
    return {
      status: out.status,
      payerRefNum: out.preauthRefNum ?? null,
      correlationId: null,
    };
  }

  async submit(input: SubmitEnhancementInput): Promise<EnhancementResponse> {
    // Read the prior preauthRefNum from the claim — the adapter and
    // the payer both thread the enhancement onto it. Throw a clear
    // 422 if it's missing (caller's claim was somehow in
    // ENHANCEMENT_DRAFTING without a prior approval, which the state
    // machine forbids — but be defensive anyway).
    const claim = await this.prisma.runInTenantContext(
      input.tenantId,
      'tenant',
      (tx) =>
        tx.claim.findUnique({
          where: { id: input.claimId },
          select: { preauthRefNum: true, payerCode: true },
        }),
    );
    if (!claim) throw new ClaimNotFoundError();
    if (!claim.preauthRefNum) {
      throw new ValidationFailedError({
        preauthRefNum: [
          'Cannot submit an enhancement without a prior preauth approval (preauthRefNum is null on the claim).',
        ],
      });
    }

    // 1. Flip to ENHANCEMENT_QUEUED + stamp the new requested amount
    //    onto the claim. The state machine writes the ClaimEvent.
    await this.claims.transition({
      tenantId: input.tenantId,
      claimId: input.claimId,
      eventType: 'enhancement.submitted_internally',
      actorUserId: input.actorUserId,
      patch: { preauthAmount: input.revisedAmount },
      payload: { revisedAmount: input.revisedAmount, reason: input.reason },
    });

    // 2. Write the outbound integration_message row pre-adapter so the
    //    ledger captures the request even if the adapter throws.
    const correlationIdPlaceholder = `enh-${input.claimId.slice(0, 8)}-${Date.now()}`;
    const outboundRow = await this.prisma.runInTenantContext(
      input.tenantId,
      'tenant',
      async (tx) =>
        this.integration.recordOutboundWithTx(tx, {
          tenantId: input.tenantId,
          claimId: input.claimId,
          integration: 'nhcx',
          operation: 'preauth.submit', // wire-level: enhancement IS a preauth/submit
          correlationId: correlationIdPlaceholder,
          rawRequest: {
            kind: 'enhancement',
            priorPreauthRefNum: claim.preauthRefNum,
            revisedAmount: input.revisedAmount,
            reason: input.reason,
          },
        }),
    );

    // 3. Adapter call. Wrap in try/catch so a thrown error marks the
    //    integration_message row failed before re-throwing — keeps
    //    the ledger consistent without forcing the operator to wonder
    //    "was this sent or not?"
    let adapterResult;
    try {
      adapterResult = await this.nhcx.submitEnhancement({
        tenantId: input.tenantId,
        claimId: input.claimId,
        priorPreauthRefNum: claim.preauthRefNum,
        revisedAmount: input.revisedAmount,
        reason: input.reason,
        ...(claim.payerCode
          ? { coverage: { payerCode: claim.payerCode, memberId: '' } }
          : {}),
      });
    } catch (err) {
      this.log.error(
        `enhancement submit failed claimId=${input.claimId} err=${(err as Error).message}`,
      );
      await this.integration.markFailed({
        tenantId: input.tenantId,
        outboundId: outboundRow.id,
        correlationId: correlationIdPlaceholder,
        integration: 'nhcx',
        operation: 'preauth.submit',
        claimId: input.claimId,
        failureClass: 'unknown',
        rawResponse: { error: (err as Error).message },
      });
      throw err;
    }

    // 4. Mark the integration ledger succeeded with the real
    //    correlationId echoed back.
    await this.integration.markSucceeded({
      tenantId: input.tenantId,
      outboundId: outboundRow.id,
      correlationId: adapterResult.correlationId,
      integration: 'nhcx',
      operation: 'preauth.submit',
      claimId: input.claimId,
      rawResponse: adapterResult.rawResponse,
    });

    // 5. On adapter ack, drive ENHANCEMENT_QUEUED → ENHANCEMENT_SUBMITTED.
    //    Real-mode would normally wait for the inbound preauth/on_submit
    //    callback to drive this; the stub adapter returns synchronously
    //    so we transition immediately. When real-mode lands the wait
    //    moves to the inbound dispatcher and this branch becomes
    //    stub-only (same shape as preauth.service.ts).
    let finalStatus = 'ENHANCEMENT_QUEUED';
    if (adapterResult.acknowledged) {
      const snap = await this.claims.transition({
        tenantId: input.tenantId,
        claimId: input.claimId,
        eventType: 'enhancement.acknowledged',
        actorUserId: input.actorUserId,
        payload: { correlationId: adapterResult.correlationId },
      });
      finalStatus = snap.status;
    }

    return {
      status: finalStatus,
      payerRefNum: adapterResult.payerRefNum,
      correlationId: adapterResult.correlationId,
    };
  }
}
