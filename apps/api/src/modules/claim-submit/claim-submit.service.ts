import { randomUUID } from 'node:crypto';

import {
  type ClaimDecisionKind,
  type ClaimSubmissionResponse,
  type ReprocessReasonCode,
} from '@claims/contracts';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ValidationFailedError } from '../../common/errors/validation-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { type AppConfig } from '../../config/configuration';
import { BiometricAuthService } from '../biometric-auth';
import { ClaimService } from '../claim';
import { DocumentService } from '../document';
import {
  classifyAdapterError,
  IntegrationMessageService,
  NhcxReplayWorker,
} from '../integration';
import { FhirContextService, NHCX_ADAPTER, type NhcxAdapter } from '../nhcx';
import { TenantService } from '../tenant/tenant.service';

export interface StartInput {
  tenantId: string;
  claimId: string;
  actorUserId: string;
}

export interface SubmitInput extends StartInput {
  finalAmount: number;
}

export interface DecisionInput {
  tenantId: string;
  claimId: string;
  // Null when the decision arrives via the NHCX inbound webhook —
  // there's no logged-in user; the platform applies the transition
  // on behalf of the gateway.
  actorUserId: string | null;
  kind: ClaimDecisionKind;
  approvedAmount?: number;
  reason?: string;
  queryText?: string;
}

// Slice BI — PMJAY CRC (Claim Re-Consideration) request via outbound
// `task/submit`. PMJAY-only in v1; the controller asserts
// tenant.pmjayMode === 'on'. Reason flows into the FHIR Task.note
// for the payer's audit trail; reasonCode dictates which CRC queue
// the payer routes the request to.
export interface ReprocessClaimInput {
  tenantId: string;
  claimId: string;
  actorUserId: string;
  reasonCode: ReprocessReasonCode;
  reason?: string;
}

@Injectable()
export class ClaimSubmitService implements OnApplicationBootstrap {
  private readonly log = new Logger(ClaimSubmitService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly claims: ClaimService,
    private readonly integration: IntegrationMessageService,
    private readonly documents: DocumentService,
    private readonly fhirContext: FhirContextService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly tenants: TenantService,
    private readonly biometric: BiometricAuthService,
    @Inject(NHCX_ADAPTER) private readonly nhcx: NhcxAdapter,
    private readonly replay: NhcxReplayWorker,
  ) {}

  // T1-5 — register replay handler for 'claim.submit' rows so the
  // NhcxReplayWorker knows how to retry parked submissions.
  onApplicationBootstrap(): void {
    this.replay.registerHandler({
      operation: 'claim.submit',
      handle: async (ctx) => this.replayQueuedClaim(ctx),
    });
  }

  async start(input: StartInput): Promise<{ status: string }> {
    const snap = await this.claims.transition({
      tenantId: input.tenantId,
      claimId: input.claimId,
      eventType: 'claim.drafting_started',
      actorUserId: input.actorUserId,
    });
    return { status: snap.status };
  }

  async submit(input: SubmitInput): Promise<ClaimSubmissionResponse> {
    if (input.finalAmount <= 0) {
      throw new ValidationFailedError({ finalAmount: ['Must be positive.'] });
    }

    // Slice BG — PMJAY tenants must have a recent ABDM biometric
    // verification (process='Discharge') on the case before claim
    // submit. Mirrors the preauth gate pattern.
    const tenant = await this.tenants.findById(input.tenantId);
    if (tenant?.pmjayMode === 'on') {
      const claim = await this.prisma.runInTenantContext(input.tenantId, 'tenant', (tx) =>
        tx.claim.findUniqueOrThrow({
          where: { id: input.claimId },
          select: { caseId: true },
        }),
      );
      await this.biometric.assertVerifiedFor(input.tenantId, claim.caseId, 'Discharge');
    }

    // Transition draft → queued.
    await this.claims.transition({
      tenantId: input.tenantId,
      claimId: input.claimId,
      eventType: 'claim.submitted_internally',
      actorUserId: input.actorUserId,
      patch: { claimAmount: input.finalAmount },
    });

    // Adapter call. Slice AA enrichment: pass FHIR context + the
    // preauth draft's diagnosis / procedure fields + uploaded document
    // ids so the JWE adapter materialises a real Claim use=claim
    // Bundle. Fields are pulled from the preauth draft because the
    // claim-submit phase doesn't capture them again — they were frozen
    // at preauth time. Documents come from the materialised list.
    // Slice CB: thread consent ctx so the patient decrypt happening
    // inside fhirContext.build binds to the active grant.
    const fhirCtx = await this.fhirContext.build(input.tenantId, input.claimId, {
      actorUserId: input.actorUserId,
      actorType: 'user',
      purpose: 'claim.submit',
    });
    const draft = await this.prisma.runInTenantContext(input.tenantId, 'tenant', (tx) =>
      tx.preauthDraft.findUnique({ where: { claimId: input.claimId } }),
    );
    const docs = await this.documents.list(input.tenantId, input.claimId);
    const adapterPayload = {
      tenantId: input.tenantId,
      claimId: input.claimId,
      finalAmount: input.finalAmount,
      ...(fhirCtx.patient !== undefined ? { patient: fhirCtx.patient } : {}),
      ...(fhirCtx.coverage !== undefined ? { coverage: fhirCtx.coverage } : {}),
      documentIds: docs.map((d) => d.id),
      ...(draft?.diagnosisIcdCode ? { diagnosisIcdCode: draft.diagnosisIcdCode } : {}),
      ...(draft?.diagnosisDescription ? { diagnosisDescription: draft.diagnosisDescription } : {}),
      ...(draft?.plannedProcedure ? { plannedProcedure: draft.plannedProcedure } : {}),
      ...(draft?.procedureCode ? { procedureCode: draft.procedureCode } : {}),
      ...(draft?.clinicalJustification
        ? { clinicalJustification: draft.clinicalJustification }
        : {}),
    };
    // T1-5 — classify-and-park around the adapter call. Transient
    // adapter failures park an outbound row at status='queued_for_retry';
    // the NhcxReplayWorker re-issues once the gateway recovers. Claim
    // stays at CLAIM_QUEUED (set by the claim.submitted_internally
    // transition above). Permanent failures bubble up unchanged.
    let adapter;
    try {
      adapter = await this.nhcx.submitClaim(adapterPayload);
    } catch (err) {
      const classified = classifyAdapterError(err);
      if (classified.classification === 'transient') {
        return this.parkClaimForReplay({
          tenantId: input.tenantId,
          claimId: input.claimId,
          adapterRequest: adapterPayload,
          failureClass: classified.failureClass,
          message: classified.message,
        });
      }
      throw err;
    }

    // Ledger rows + transition queued → submitted.
    const outboundId = await this.prisma.runInTenantContext(
      input.tenantId,
      'tenant',
      async (tx) => {
        const row = await this.integration.recordOutboundWithTx(tx, {
          tenantId: input.tenantId,
          claimId: input.claimId,
          integration: 'nhcx',
          operation: 'claim.submit',
          correlationId: adapter.correlationId,
          rawRequest: adapter.rawRequest,
        });
        return row.id;
      },
    );
    // Slice AE: real mode = the gateway will POST a claim/on_submit
    // callback that runs the QUEUED → SUBMITTED ack + the decision
    // transition. Stop at QUEUED here. Same shape as Slice AD's
    // preauth flip.
    //
    // Stamp claimRefNum on the claim row even though we're not
    // transitioning past QUEUED — the JWE adapter returns it
    // synchronously (it's in the gateway's HTTP response envelope)
    // and ops want to see it immediately. The patch is on the
    // claim_event we already wrote at submitted_internally; since
    // ClaimService.transition.patch only fires at transition time,
    // we go through the prisma model directly here.
    if (this.config.get('NHCX_MODE', { infer: true }) === 'real') {
      const pendingSnap = await this.prisma.runInTenantContext(
        input.tenantId,
        'tenant',
        async (tx) => {
          await tx.claim.update({
            where: { id: input.claimId },
            data: { claimRefNum: adapter.claimRefNum },
          });
          return tx.claim.findUniqueOrThrow({ where: { id: input.claimId } });
        },
      );
      void outboundId;
      return {
        status: pendingSnap.status,
        claimRefNum: adapter.claimRefNum,
        correlationId: adapter.correlationId,
      };
    }

    await this.integration.markSucceeded({
      tenantId: input.tenantId,
      outboundId,
      correlationId: adapter.correlationId,
      integration: 'nhcx',
      operation: 'claim.submit',
      claimId: input.claimId,
      rawResponse: adapter.rawResponse,
    });

    const snap = await this.claims.transition({
      tenantId: input.tenantId,
      claimId: input.claimId,
      eventType: 'claim.acknowledged',
      actorUserId: input.actorUserId,
      correlationId: adapter.correlationId,
      patch: { claimRefNum: adapter.claimRefNum },
    });
    return {
      status: snap.status,
      claimRefNum: adapter.claimRefNum,
      correlationId: adapter.correlationId,
    };
  }

  // Slice BI — PMJAY CRC reprocess via outbound `task/submit`.
  // Mirrors PreauthService.cancelPreauth (Slice BH): tenant gate →
  // claimRefNum check → adapter call → ledger pair → state
  // transition. The payer's re-decision flows back through the
  // existing claim/on_submit inbound handler.
  async reprocessClaim(input: ReprocessClaimInput): Promise<{
    status: string;
    correlationId: string;
  }> {
    // PMJAY-only in v1 — `task/submit reprocess` is the PMJAY CRC
    // surface. Non-PMJAY tenants don't have a defined CRC pathway.
    const tenant = await this.tenants.findById(input.tenantId);
    if (tenant?.pmjayMode !== 'on') {
      throw new ValidationFailedError({
        tenant: ['Claim reprocess is currently a PMJAY-only operation.'],
      });
    }

    const claim = await this.prisma.runInTenantContext(input.tenantId, 'tenant', (tx) =>
      tx.claim.findUniqueOrThrow({
        where: { id: input.claimId },
        select: { claimRefNum: true, payerCode: true, status: true },
      }),
    );
    if (!claim.claimRefNum) {
      throw new ValidationFailedError({
        claimRefNum: ['Reprocess requires a claim reference issued by the payer.'],
      });
    }

    // Cross-check: the operator-supplied reasonCode must match the
    // claim's current state. 'claimrejected' is only meaningful from
    // CLAIM_REJECTED; 'partialpayment' is only meaningful from
    // SHORT_PAID. The state-machine guard catches wrong-status
    // calls too, but surfacing the mismatch as a field-targeted
    // validation error gives the frontend a cleaner modal.
    if (input.reasonCode === 'claimrejected' && claim.status !== 'CLAIM_REJECTED') {
      throw new ValidationFailedError({
        reasonCode: [
          `reasonCode='claimrejected' requires claim status CLAIM_REJECTED (current: ${claim.status}).`,
        ],
      });
    }
    if (input.reasonCode === 'partialpayment' && claim.status !== 'SHORT_PAID') {
      throw new ValidationFailedError({
        reasonCode: [
          `reasonCode='partialpayment' requires claim status SHORT_PAID (current: ${claim.status}).`,
        ],
      });
    }

    const fhirCtx = await this.fhirContext.build(input.tenantId, input.claimId, {
      actorUserId: input.actorUserId,
      actorType: 'user',
      purpose: 'claim.reprocess',
    });
    const adapterResult = await this.nhcx.reprocessClaim({
      tenantId: input.tenantId,
      claimId: input.claimId,
      claimRefNum: claim.claimRefNum,
      reasonCode: input.reasonCode,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(fhirCtx.patient !== undefined ? { patient: fhirCtx.patient } : {}),
      ...(fhirCtx.coverage !== undefined ? { coverage: fhirCtx.coverage } : {}),
    });

    const outboundId = await this.prisma.runInTenantContext(
      input.tenantId,
      'tenant',
      async (tx) => {
        const row = await this.integration.recordOutboundWithTx(tx, {
          tenantId: input.tenantId,
          claimId: input.claimId,
          integration: 'nhcx',
          operation: 'claim.reprocess',
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
      operation: 'claim.reprocess',
      claimId: input.claimId,
      rawResponse: adapterResult.rawResponse,
    });

    const snap = await this.claims.transition({
      tenantId: input.tenantId,
      claimId: input.claimId,
      eventType: 'claim.reprocess_requested',
      actorUserId: input.actorUserId,
      correlationId: adapterResult.correlationId,
      payload: { reasonCode: input.reasonCode, ...(input.reason ? { reason: input.reason } : {}) },
    });

    return { status: snap.status, correlationId: adapterResult.correlationId };
  }

  // Slice BL — PMJAY-only. Pull a queried claim back to CLAIM_DRAFTING
  // so the operator can edit and re-submit. State-only flip; no
  // outbound NHCX call. Mirrors `preauthService.resubmitOnQuery`.
  async resubmitOnQuery(input: {
    tenantId: string;
    claimId: string;
    actorUserId: string;
    reason?: string;
  }): Promise<{ status: string }> {
    const tenant = await this.tenants.findById(input.tenantId);
    if (tenant?.pmjayMode !== 'on') {
      throw new ValidationFailedError({
        tenant: ['Claim resubmit on query is currently a PMJAY-only operation.'],
      });
    }
    const snap = await this.claims.transition({
      tenantId: input.tenantId,
      claimId: input.claimId,
      eventType: 'claim.resubmission_started',
      actorUserId: input.actorUserId,
      payload: input.reason ? { reason: input.reason } : {},
    });
    return { status: snap.status };
  }

  async applyDecision(input: DecisionInput): Promise<{
    status: string;
    approvedAmount: number | null;
  }> {
    if (input.kind === 'query_received') {
      if (!input.queryText) {
        throw new ValidationFailedError({
          queryText: ['Required when kind is query_received.'],
        });
      }
      const snap = await this.claims.transition({
        tenantId: input.tenantId,
        claimId: input.claimId,
        eventType: 'claim.query_received',
        actorUserId: input.actorUserId,
        payload: { queryText: input.queryText },
      });
      return { status: snap.status, approvedAmount: snap.approvedAmount };
    }

    const eventType =
      input.kind === 'approved'
        ? 'claim.approved'
        : input.kind === 'rejected'
          ? 'claim.rejected'
          : 'claim.partially_approved';

    const patch: Record<string, unknown> = {};
    if (input.kind === 'approved' || input.kind === 'partially_approved') {
      if (input.approvedAmount === undefined) {
        throw new ValidationFailedError({
          approvedAmount: ['Required for approval decisions.'],
        });
      }
      patch['approvedAmount'] = input.approvedAmount;
    }

    const snap = await this.claims.transition({
      tenantId: input.tenantId,
      claimId: input.claimId,
      eventType,
      actorUserId: input.actorUserId,
      payload: input.reason ? { reason: input.reason } : {},
      patch,
    });
    return { status: snap.status, approvedAmount: snap.approvedAmount };
  }

  // Slice AE entry point. Called by NhcxInboundService when a
  // claim/on_submit callback arrives. Same two-step shape as Slice AD
  // for preauth: ack QUEUED → SUBMITTED first (if needed), then run
  // the decision via applyDecision.
  async handleInboundResponse(input: {
    tenantId: string;
    claimId: string;
    correlationId: string;
    parsed: {
      kind: 'approved' | 'rejected' | 'partially_approved' | 'query_received';
      approvedAmount?: number;
      reason?: string;
      queryText?: string;
    };
    claimRefNum?: string;
  }): Promise<{ status: string; approvedAmount: number | null }> {
    const claim = await this.prisma.runInTenantContext(
      input.tenantId,
      'platform_admin',
      (tx) => tx.claim.findUniqueOrThrow({ where: { id: input.claimId } }),
    );
    if (claim.status === 'CLAIM_QUEUED') {
      await this.claims.transition({
        tenantId: input.tenantId,
        claimId: input.claimId,
        eventType: 'claim.acknowledged',
        actorUserId: null,
        correlationId: input.correlationId,
        ...(input.claimRefNum !== undefined ? { patch: { claimRefNum: input.claimRefNum } } : {}),
      });
    }

    return this.applyDecision({
      tenantId: input.tenantId,
      claimId: input.claimId,
      actorUserId: null,
      kind: input.parsed.kind,
      ...(input.parsed.approvedAmount !== undefined
        ? { approvedAmount: input.parsed.approvedAmount }
        : {}),
      ...(input.parsed.reason !== undefined ? { reason: input.parsed.reason } : {}),
      ...(input.parsed.queryText !== undefined ? { queryText: input.parsed.queryText } : {}),
    });
  }

  // T1-5 — park a transient-failed claim submit. Outbound row carries
  // a server-generated correlationId so the worker's retry can be
  // matched on the gateway. Claim stays at CLAIM_QUEUED; operator
  // sees the same "submitted, awaiting payer" surface they'd see in
  // real mode. claimRefNum is unknown until replay succeeds.
  private async parkClaimForReplay(input: {
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
  }): Promise<ClaimSubmissionResponse> {
    const correlationId = randomUUID();
    const outboundId = await this.prisma.runInTenantContext(
      input.tenantId,
      'tenant',
      async (tx) => {
        const row = await this.integration.recordOutboundWithTx(tx, {
          tenantId: input.tenantId,
          claimId: input.claimId,
          integration: 'nhcx',
          operation: 'claim.submit',
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
      `claim queued for replay claimId=${input.claimId} correlationId=${correlationId} reason=${input.message}`,
    );
    const pendingSnap = await this.prisma.runInTenantContext(
      input.tenantId,
      'platform_admin',
      (tx) => tx.claim.findUniqueOrThrow({ where: { id: input.claimId } }),
    );
    return {
      status: pendingSnap.status,
      claimRefNum: '',
      correlationId,
    };
  }

  // T1-5 — replay handler for 'claim.submit' rows. Mirrors the
  // preauth template:
  //   * Idempotency guard: only retry while claim is at CLAIM_QUEUED.
  //     Acknowledged / approved / rejected / query raised / closed
  //     means the flow has already moved on — mark exhausted.
  //   * Re-derive the adapter request from current state
  //     (PreauthDraft for clinical fields, Document list for the
  //     attached EOB-able docs, Claim row for finalAmount via
  //     claimAmount, FhirContext for patient + coverage).
  //   * On adapter success: markReplaySucceeded + stamp claimRefNum
  //     on the claim row + (stub mode only) drive the QUEUED →
  //     ACKNOWLEDGED transition. Real mode waits for the gateway's
  //     claim/on_submit callback (matches happy-path code).
  //   * Transient again → 'transient'; permanent → 'permanent'.
  private async replayQueuedClaim(ctx: {
    outboundId: string;
    tenantId: string;
    claimId: string | null;
    correlationId: string;
  }): Promise<'succeeded' | 'transient' | 'permanent'> {
    if (!ctx.claimId) return 'permanent';

    const ctxRow = await this.prisma.runInTenantContext(
      ctx.tenantId,
      'tenant',
      async (tx) => {
        const c = await tx.claim.findUnique({ where: { id: ctx.claimId! } });
        if (!c) return null;
        if (c.status !== 'CLAIM_QUEUED') {
          return { skip: true as const, status: c.status };
        }
        if (c.claimAmount === null) {
          // Defensive: claim was queued without a finalAmount set,
          // which the state machine shouldn't allow. Mark permanent.
          return { skip: true as const, status: c.status };
        }
        const d = await tx.preauthDraft.findUnique({ where: { claimId: ctx.claimId! } });
        return { skip: false as const, claim: c, draft: d };
      },
    );
    if (ctxRow === null) return 'permanent';
    if (ctxRow.skip) {
      await this.integration.markReplayExhausted({
        tenantId: ctx.tenantId,
        outboundId: ctx.outboundId,
        failureClass: 'unknown',
      });
      this.log.log(
        `claim replay skipped (claim already at ${ctxRow.status}) outboundId=${ctx.outboundId}`,
      );
      return 'succeeded';
    }

    const { claim, draft } = ctxRow;
    const fhirCtx = await this.fhirContext.build(ctx.tenantId, ctx.claimId, {
      actorUserId: null,
      actorType: 'system',
      purpose: 'claim.submit',
    });
    const docs = await this.documents.list(ctx.tenantId, ctx.claimId);
    const adapterPayload = {
      tenantId: ctx.tenantId,
      claimId: ctx.claimId,
      finalAmount: claim.claimAmount!,
      ...(fhirCtx.patient !== undefined ? { patient: fhirCtx.patient } : {}),
      ...(fhirCtx.coverage !== undefined ? { coverage: fhirCtx.coverage } : {}),
      documentIds: docs.map((d) => d.id),
      ...(draft?.diagnosisIcdCode ? { diagnosisIcdCode: draft.diagnosisIcdCode } : {}),
      ...(draft?.diagnosisDescription
        ? { diagnosisDescription: draft.diagnosisDescription }
        : {}),
      ...(draft?.plannedProcedure ? { plannedProcedure: draft.plannedProcedure } : {}),
      ...(draft?.procedureCode ? { procedureCode: draft.procedureCode } : {}),
      ...(draft?.clinicalJustification
        ? { clinicalJustification: draft.clinicalJustification }
        : {}),
    };

    let result;
    try {
      result = await this.nhcx.submitClaim(adapterPayload);
    } catch (err) {
      const classified = classifyAdapterError(err);
      return classified.classification === 'transient' ? 'transient' : 'permanent';
    }

    await this.integration.markReplaySucceeded({
      tenantId: ctx.tenantId,
      outboundId: ctx.outboundId,
      correlationId: result.correlationId,
      integration: 'nhcx',
      operation: 'claim.submit',
      claimId: ctx.claimId,
      rawResponse: result.rawResponse,
    });
    // Stamp claimRefNum on the claim row regardless of mode so ops
    // sees the gateway-assigned id immediately.
    await this.prisma.runInTenantContext(ctx.tenantId, 'tenant', async (tx) => {
      await tx.claim.update({
        where: { id: ctx.claimId! },
        data: { claimRefNum: result.claimRefNum },
      });
    });
    // Stub mode: drive ack transition. Real mode: let the inbound
    // dispatcher's claim/on_submit handler do it.
    if (this.config.get('NHCX_MODE', { infer: true }) !== 'real') {
      await this.claims.transition({
        tenantId: ctx.tenantId,
        claimId: ctx.claimId,
        eventType: 'claim.acknowledged',
        actorUserId: null,
        correlationId: result.correlationId,
      });
    }
    this.log.log(
      `claim replay succeeded claimId=${ctx.claimId} claimRefNum=${result.claimRefNum} correlationId=${result.correlationId}`,
    );
    return 'succeeded';
  }
}
