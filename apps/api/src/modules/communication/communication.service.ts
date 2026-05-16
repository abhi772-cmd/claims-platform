import { randomUUID } from 'node:crypto';

import { type CommunicationEntry } from '@claims/contracts';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';

import { ClaimNotFoundError } from '../../common/errors/claim-errors';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  classifyAdapterError,
  IntegrationMessageService,
  NhcxReplayWorker,
} from '../integration';
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
export class CommunicationService implements OnApplicationBootstrap {
  private readonly log = new Logger(CommunicationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(NHCX_ADAPTER) private readonly nhcx: NhcxAdapter,
    private readonly integration: IntegrationMessageService,
    private readonly fhirContext: FhirContextService,
    private readonly replay: NhcxReplayWorker,
  ) {}

  // T1-5 — register replay handler for 'communication.request' so
  // the NhcxReplayWorker knows how to retry parked messages.
  onApplicationBootstrap(): void {
    this.replay.registerHandler({
      operation: 'communication.request',
      handle: async (ctx) => this.replayQueuedCommunication(ctx),
    });
  }

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

    const adapterPayload = {
      tenantId: input.tenantId,
      claimId: input.claimId,
      text: trimmed,
      ...(fhirCtx.patient !== undefined ? { patient: fhirCtx.patient } : {}),
      ...(fhirCtx.coverage !== undefined ? { coverage: fhirCtx.coverage } : {}),
      ...(inReplyToRefNum !== null ? { inReplyToRefNum } : {}),
    };
    // T1-5 — classify-and-park. Transient adapter failure parks an
    // outbound row at status='queued_for_retry'; the
    // NhcxReplayWorker re-issues once the gateway recovers. The
    // ClaimEvent timeline entry is also written here so the case-
    // detail panel shows the message as sent (it just hasn't been
    // confirmed by the gateway yet). Operator-facing: same shape
    // as a normal send — no error surfaced.
    //
    // Permanent failures bubble up.
    let adapterResult;
    try {
      adapterResult = await this.nhcx.sendCommunication(adapterPayload);
    } catch (err) {
      const classified = classifyAdapterError(err);
      if (classified.classification === 'transient') {
        return this.parkCommunicationForReplay({
          tenantId: input.tenantId,
          claimId: input.claimId,
          claimStatus: claim.status,
          text: trimmed,
          inReplyToCorrelationId: input.inReplyToCorrelationId,
          inReplyToRefNum,
          actorUserId: input.actorUserId,
          adapterRequest: adapterPayload,
          failureClass: classified.failureClass,
          message: classified.message,
        });
      }
      throw err;
    }

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
          queued?: boolean;
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
          // Surface the replay-queue flag (only meaningful on outbound).
          queued: direction === 'outbound' && payload.queued === true,
        };
      }),
    };
  }

  // T1-5 — park a transient-failed communication send. Writes the
  // outbound integration_message row at status='queued_for_retry'
  // AND appends the ClaimEvent timeline entry so the operator sees
  // their message in the case-detail panel right away (rather than
  // a hard error). When the worker re-issues and the gateway accepts,
  // the inbound row is written normally; the ClaimEvent already in
  // place doesn't need updating — correlationId stays consistent.
  private async parkCommunicationForReplay(input: {
    tenantId: string;
    claimId: string;
    claimStatus: string;
    text: string;
    inReplyToCorrelationId?: string;
    inReplyToRefNum: string | null;
    actorUserId: string;
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
  }): Promise<SendOutboundResult> {
    const correlationId = randomUUID();
    const outboundId = await this.prisma.runInTenantContext(
      input.tenantId,
      'tenant',
      async (tx) => {
        const row = await this.integration.recordOutboundWithTx(tx, {
          tenantId: input.tenantId,
          claimId: input.claimId,
          integration: 'nhcx',
          operation: 'communication.request',
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
      `communication queued for replay claimId=${input.claimId} correlationId=${correlationId} reason=${input.message}`,
    );

    // Write the ClaimEvent so the case-detail timeline reflects the
    // operator's intent. resultingStatus stays at the claim's current
    // status (communication is non-transitioning).
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
          resultingStatus: input.claimStatus,
          occurredAt,
          recordedById: input.actorUserId,
          payload: {
            direction: 'outbound',
            text: input.text,
            queued: true,
            ...(input.inReplyToCorrelationId
              ? { inReplyToCorrelationId: input.inReplyToCorrelationId }
              : {}),
            ...(input.inReplyToRefNum ? { inReplyToRefNum: input.inReplyToRefNum } : {}),
          } as never,
          correlationId,
          prevEventId: prevEvent?.id ?? null,
        },
      });
    });
    return {
      correlationId,
      sentAt: occurredAt.toISOString(),
    };
  }

  // T1-5 — replay handler for 'communication.request' rows. Lighter
  // template than preauth/claim-submit because communications are
  // non-transitioning — there's no state machine to coordinate. We
  // just re-derive the text + recipient from the original ClaimEvent
  // payload, re-call the adapter with the SAME correlationId so the
  // gateway can dedup, and mark the row succeeded.
  //
  // Idempotency: communications don't have a "this conversation
  // already moved on" guard like preauth/claim do — every
  // communication is a one-shot send. The retry attempt is safe to
  // re-issue without checking claim state because the message itself
  // doesn't change the state machine.
  private async replayQueuedCommunication(ctx: {
    outboundId: string;
    tenantId: string;
    claimId: string | null;
    correlationId: string;
  }): Promise<'succeeded' | 'transient' | 'permanent'> {
    if (!ctx.claimId) return 'permanent';

    const original = await this.prisma.runInTenantContext(
      ctx.tenantId,
      'tenant',
      async (tx) => {
        const event = await tx.claimEvent.findFirst({
          where: {
            tenantId: ctx.tenantId,
            claimId: ctx.claimId!,
            eventType: 'communication.outbound_sent',
            correlationId: ctx.correlationId,
          },
        });
        if (!event) return null;
        return {
          payload: event.payload as Record<string, unknown> | null,
        };
      },
    );
    if (original === null) return 'permanent';
    const text =
      original.payload && typeof original.payload['text'] === 'string'
        ? (original.payload['text'] as string)
        : null;
    const inReplyToRefNum =
      original.payload && typeof original.payload['inReplyToRefNum'] === 'string'
        ? (original.payload['inReplyToRefNum'] as string)
        : null;
    if (!text) return 'permanent';

    const fhirCtx = await this.fhirContext.build(ctx.tenantId, ctx.claimId, {
      actorUserId: null,
      actorType: 'system',
      purpose: 'communication.send',
    });

    let result;
    try {
      result = await this.nhcx.sendCommunication({
        tenantId: ctx.tenantId,
        claimId: ctx.claimId,
        text,
        ...(fhirCtx.patient !== undefined ? { patient: fhirCtx.patient } : {}),
        ...(fhirCtx.coverage !== undefined ? { coverage: fhirCtx.coverage } : {}),
        ...(inReplyToRefNum !== null ? { inReplyToRefNum } : {}),
      });
    } catch (err) {
      const classified = classifyAdapterError(err);
      return classified.classification === 'transient' ? 'transient' : 'permanent';
    }

    await this.integration.markReplaySucceeded({
      tenantId: ctx.tenantId,
      outboundId: ctx.outboundId,
      correlationId: result.correlationId,
      integration: 'nhcx',
      operation: 'communication.request',
      claimId: ctx.claimId,
      rawResponse: result.rawResponse,
    });
    this.log.log(
      `communication replay succeeded claimId=${ctx.claimId} correlationId=${result.correlationId}`,
    );
    return 'succeeded';
  }
}
