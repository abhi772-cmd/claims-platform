import { type CommunicationEntry } from '@claims/contracts';
import { Inject, Injectable } from '@nestjs/common';

import { ClaimNotFoundError } from '../../common/errors/claim-errors';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IntegrationMessageService } from '../integration';
import { FhirContextService, NHCX_ADAPTER, type NhcxAdapter } from '../nhcx';

// Stage 5 — hospital-initiated communication/request.
//
// The outbound flow mirrors `preauth.respondToQuery` exactly:
//   1. resolve the claim under tenant RLS
//   2. build FHIR context (patient + coverage actor codes)
//   3. call the adapter (operation: communication/request)
//   4. record the IntegrationMessage outbound row + markSucceeded
//   5. append a non-transitioning ClaimEvent (`communication.outbound_sent`)
//
// The ClaimEvent's `resultingStatus` is set to the claim's CURRENT
// status — communications do not move the state machine. They are an
// audit + UI-timeline gesture; the state machine still lives on
// preauth.* / claim.* events.

export interface SendOutboundInput {
  tenantId: string;
  claimId: string;
  actorUserId: string;
  text: string;
  inReplyToCorrelationId?: string;
}

export interface SendOutboundResult {
  correlationId: string;
  sentAt: string;
}

@Injectable()
export class CommunicationService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(NHCX_ADAPTER) private readonly nhcx: NhcxAdapter,
    private readonly integration: IntegrationMessageService,
    private readonly fhirContext: FhirContextService,
  ) {}

  async sendOutbound(input: SendOutboundInput): Promise<SendOutboundResult> {
    const trimmed = input.text.trim();
    if (trimmed.length === 0) {
      throw new ValidationFailedError({ text: ['Message text is required.'] });
    }

    // Resolve the claim + capture inReplyToRefNum from the prior
    // event in the chain (if the operator pointed at one).
    const { claim, inReplyToRefNum } = await this.prisma.runInTenantContext(
      input.tenantId,
      'tenant',
      async (tx) => {
        const c = await tx.claim.findUnique({ where: { id: input.claimId } });
        if (!c || c.tenantId !== input.tenantId) throw new ClaimNotFoundError();
        let ref: string | null = null;
        if (input.inReplyToCorrelationId) {
          const prior = await tx.claimEvent.findFirst({
            where: {
              tenantId: input.tenantId,
              claimId: input.claimId,
              correlationId: input.inReplyToCorrelationId,
            },
            orderBy: { occurredAt: 'desc' },
          });
          if (!prior) {
            throw new ValidationFailedError({
              inReplyToCorrelationId: [
                'No prior message on this claim matches that correlationId.',
              ],
            });
          }
          // Thread onto the payer-side reference if we have one. Falls
          // back to the claim's preauth ref, then the claim ref — these
          // are the same identifiers the payer sees on their side.
          ref = c.preauthRefNum ?? c.claimRefNum ?? c.payerRefNum;
        }
        return { claim: c, inReplyToRefNum: ref };
      },
    );

    const fhirCtx = await this.fhirContext.build(input.tenantId, input.claimId, {
      actorUserId: input.actorUserId,
      actorType: 'user',
      purpose: 'communication.send',
    });

    const adapterResult = await this.nhcx.sendCommunication({
      tenantId: input.tenantId,
      claimId: input.claimId,
      text: trimmed,
      ...(fhirCtx.patient !== undefined ? { patient: fhirCtx.patient } : {}),
      ...(fhirCtx.coverage !== undefined ? { coverage: fhirCtx.coverage } : {}),
      ...(inReplyToRefNum !== null ? { inReplyToRefNum } : {}),
    });

    const outboundId = await this.prisma.runInTenantContext(
      input.tenantId,
      'tenant',
      async (tx) => {
        const row = await this.integration.recordOutboundWithTx(tx, {
          tenantId: input.tenantId,
          claimId: input.claimId,
          integration: 'nhcx',
          operation: 'communication.request',
          correlationId: adapterResult.correlationId,
          rawRequest: adapterResult.rawRequest,
        });
        return row.id;
      },
    );
    await this.integration.markSucceeded({
      tenantId: input.tenantId,
      outboundId,
      correlationId: adapterResult.correlationId,
      integration: 'nhcx',
      operation: 'communication.request',
      claimId: input.claimId,
      rawResponse: adapterResult.rawResponse,
    });

    // Append the non-transitioning ClaimEvent for the case-detail
    // timeline. resultingStatus stays at the claim's current status.
    const occurredAt = new Date();
    await this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const prevEvent = await tx.claimEvent.findFirst({
        where: { claimId: input.claimId, tenantId: input.tenantId },
        orderBy: { occurredAt: 'desc' },
        select: { id: true },
      });
      await tx.claimEvent.create({
        data: {
          tenantId: input.tenantId,
          claimId: input.claimId,
          eventType: 'communication.outbound_sent',
          resultingStatus: claim.status,
          occurredAt,
          recordedById: input.actorUserId,
          payload: {
            direction: 'outbound',
            text: trimmed,
            ...(input.inReplyToCorrelationId
              ? { inReplyToCorrelationId: input.inReplyToCorrelationId }
              : {}),
            ...(inReplyToRefNum ? { inReplyToRefNum } : {}),
          } as never,
          correlationId: adapterResult.correlationId,
          prevEventId: prevEvent?.id ?? null,
        },
      });
    });

    return {
      correlationId: adapterResult.correlationId,
      sentAt: occurredAt.toISOString(),
    };
  }

  // Called from the NHCX inbound dispatcher when the gateway pushes
  // a `communication/request` whose payload is a payer-initiated
  // free-form message (i.e. NOT a query the state machine already
  // handles). Writes a non-transitioning ClaimEvent so the case-detail
  // timeline picks it up alongside outbound messages.
  //
  // Idempotency: the inbound dispatcher already dedups by
  // correlationId on the IntegrationMessage row before calling here,
  // so we don't re-check. If a re-run does occur, we de-dup by
  // matching (claimId, correlationId, eventType).
  async recordInbound(input: {
    tenantId: string;
    claimId: string;
    text: string;
    correlationId: string;
    occurredAt?: Date;
  }): Promise<void> {
    const trimmed = input.text.trim();
    if (trimmed.length === 0) return;
    const occurredAt = input.occurredAt ?? new Date();
    await this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const existing = await tx.claimEvent.findFirst({
        where: {
          tenantId: input.tenantId,
          claimId: input.claimId,
          correlationId: input.correlationId,
          eventType: 'communication.inbound_received',
        },
        select: { id: true },
      });
      if (existing) return;
      const claim = await tx.claim.findUnique({ where: { id: input.claimId } });
      if (!claim || claim.tenantId !== input.tenantId) {
        // Mis-routed callback — caller already logged it; nothing to
        // append. Don't throw: the inbound dispatcher would mark the
        // integration row failed for a misrouted callback, which is
        // an ops concern, not a data-integrity one here.
        return;
      }
      const prevEvent = await tx.claimEvent.findFirst({
        where: { claimId: input.claimId, tenantId: input.tenantId },
        orderBy: { occurredAt: 'desc' },
        select: { id: true },
      });
      await tx.claimEvent.create({
        data: {
          tenantId: input.tenantId,
          claimId: input.claimId,
          eventType: 'communication.inbound_received',
          resultingStatus: claim.status,
          occurredAt,
          recordedById: null,
          payload: { direction: 'inbound', text: trimmed } as never,
          correlationId: input.correlationId,
          prevEventId: prevEvent?.id ?? null,
        },
      });
    });
  }

  async listForCase(
    tenantId: string,
    caseId: string,
  ): Promise<{ entries: CommunicationEntry[] }> {
    const entries = await this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const claims = await tx.claim.findMany({
        where: { caseId, tenantId },
        select: { id: true },
      });
      if (claims.length === 0) return [];
      const rows = await tx.claimEvent.findMany({
        where: {
          tenantId,
          claimId: { in: claims.map((c) => c.id) },
          eventType: {
            in: ['communication.outbound_sent', 'communication.inbound_received'],
          },
        },
        orderBy: { occurredAt: 'asc' },
      });
      return rows;
    });

    return {
      entries: entries.map((row) => {
        const payload = (row.payload ?? {}) as {
          direction?: 'outbound' | 'inbound';
          text?: string;
          inReplyToCorrelationId?: string;
        };
        const direction: 'outbound' | 'inbound' =
          payload.direction ??
          (row.eventType === 'communication.outbound_sent' ? 'outbound' : 'inbound');
        return {
          id: row.id,
          direction,
          text: payload.text ?? '',
          correlationId: row.correlationId ?? null,
          inReplyToCorrelationId: payload.inReplyToCorrelationId ?? null,
          occurredAt: row.occurredAt.toISOString(),
          recordedById: row.recordedById ?? null,
        };
      }),
    };
  }
}
