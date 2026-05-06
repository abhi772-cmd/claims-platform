import {
  type PreauthDecisionKind,
  type PreauthDraft,
  type PreauthDraftResponse,
} from '@claims/contracts';
import { Inject, Injectable } from '@nestjs/common';

import { InvalidClaimTransitionError } from '../../common/errors/claim-errors';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ClaimService } from '../claim';
import { IntegrationMessageService } from '../integration';
import { FhirContextService, NHCX_ADAPTER, type NhcxAdapter } from '../nhcx';

export interface SaveDraftInput {
  tenantId: string;
  claimId: string;
  actorUserId: string;
  draft: PreauthDraft;
}

export interface SubmitInput {
  tenantId: string;
  claimId: string;
  actorUserId: string;
  ip: string | null;
  userAgent: string | null;
}

export interface DecisionInput {
  tenantId: string;
  claimId: string;
  // Null when the decision arrives via the NHCX inbound webhook —
  // there's no logged-in user; the platform applies the transition
  // on behalf of the gateway. claim_event.actorUserId stays null.
  actorUserId: string | null;
  kind: PreauthDecisionKind;
  approvedAmount?: number;
  reason?: string;
  queryText?: string;
}

export interface QueryResponseInput {
  tenantId: string;
  claimId: string;
  queryId: string;
  actorUserId: string;
  responseText: string;
}

@Injectable()
export class PreauthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly claims: ClaimService,
    private readonly integration: IntegrationMessageService,
    private readonly fhirContext: FhirContextService,
    @Inject(NHCX_ADAPTER) private readonly nhcx: NhcxAdapter,
  ) {}

  // PUT preauth/draft — upsert. Also drives the eligibility-verified →
  // preauth-drafting transition the first time a draft is saved.
  async saveDraft(input: SaveDraftInput): Promise<PreauthDraftResponse> {
    return this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const claim = await tx.claim.findUnique({ where: { id: input.claimId } });
      if (!claim || claim.tenantId !== input.tenantId) {
        throw new ValidationFailedError({ claimId: ['Claim not found.'] });
      }

      // Upsert the draft row first (idempotent — the user can save many
      // times before submitting).
      const data = {
        ...(input.draft.diagnosisIcdCode !== undefined ? { diagnosisIcdCode: input.draft.diagnosisIcdCode } : {}),
        ...(input.draft.diagnosisDescription !== undefined ? { diagnosisDescription: input.draft.diagnosisDescription } : {}),
        ...(input.draft.plannedProcedure !== undefined ? { plannedProcedure: input.draft.plannedProcedure } : {}),
        ...(input.draft.procedureCode !== undefined ? { procedureCode: input.draft.procedureCode } : {}),
        ...(input.draft.estimatedLengthOfStayDays !== undefined ? { estimatedLengthOfStayDays: input.draft.estimatedLengthOfStayDays } : {}),
        ...(input.draft.requestedAmount !== undefined ? { requestedAmount: input.draft.requestedAmount } : {}),
        ...(input.draft.clinicalJustification !== undefined ? { clinicalJustification: input.draft.clinicalJustification } : {}),
      };

      const row = await tx.preauthDraft.upsert({
        where: { claimId: input.claimId },
        create: { tenantId: input.tenantId, claimId: input.claimId, ...data },
        update: data,
      });
      return {
        draft: pickDraft(row),
        // status is read OUTSIDE the tx after we possibly transition;
        // for simplicity we return the current claim status here. The
        // first save never transitions — we want the user to be in
        // PREAUTH_DRAFTING before they're typing, so the case detail
        // page calls preauth/start (a thin wrapper) first. Sprint 2's
        // test runs the manual transition explicitly.
        status: claim.status,
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  async submit(input: SubmitInput): Promise<{
    status: string;
    payerRefNum: string;
    correlationId: string;
  }> {
    // 1. Validate the draft has the minimum required fields. This is a
    // soft enforcement — Sprint 3 may push some fields into Zod once
    // the full master-data master matures.
    const draft = await this.prisma.runInTenantContext(input.tenantId, 'tenant', (tx) =>
      tx.preauthDraft.findUnique({ where: { claimId: input.claimId } }),
    );
    if (!draft) {
      throw new ValidationFailedError({ draft: ['Save the pre-auth draft before submitting.'] });
    }
    const errors: Record<string, string[]> = {};
    if (!draft.diagnosisDescription) errors['diagnosisDescription'] = ['Required.'];
    if (!draft.plannedProcedure) errors['plannedProcedure'] = ['Required.'];
    if (!draft.requestedAmount || draft.requestedAmount <= 0) {
      errors['requestedAmount'] = ['Must be a positive amount.'];
    }
    if (Object.keys(errors).length > 0) throw new ValidationFailedError(errors);

    // 2. Transition draft → queued.
    await this.claims.transition({
      tenantId: input.tenantId,
      claimId: input.claimId,
      eventType: 'preauth.submitted_internally',
      actorUserId: input.actorUserId,
      patch: {
        preauthAmount: draft.requestedAmount ?? 0,
      },
    });

    // 3. Adapter call (outside tx). Slice AA enrichment: pass the
    // FHIR context (patient + coverage) so the JWE adapter builds a
    // real Claim use=preauthorization Bundle. The stub ignores these
    // fields; coverage may be undefined when the case never ran
    // eligibility with a payerCode (legacy case path), in which case
    // the adapter falls back to its lightweight-payload behaviour.
    const fhirCtx = await this.fhirContext.build(input.tenantId, input.claimId);
    const adapterResult = await this.nhcx.submitPreauth({
      tenantId: input.tenantId,
      claimId: input.claimId,
      requestedAmount: draft.requestedAmount,
      ...(fhirCtx.patient !== undefined ? { patient: fhirCtx.patient } : {}),
      ...(fhirCtx.coverage !== undefined ? { coverage: fhirCtx.coverage } : {}),
      ...(draft.diagnosisIcdCode !== null ? { diagnosisIcdCode: draft.diagnosisIcdCode } : {}),
      ...(draft.diagnosisDescription !== null
        ? { diagnosisDescription: draft.diagnosisDescription }
        : {}),
      ...(draft.plannedProcedure !== null ? { plannedProcedure: draft.plannedProcedure } : {}),
      ...(draft.procedureCode !== null ? { procedureCode: draft.procedureCode } : {}),
      ...(draft.estimatedLengthOfStayDays !== null
        ? { estimatedLengthOfStayDays: draft.estimatedLengthOfStayDays }
        : {}),
      ...(draft.clinicalJustification !== null
        ? { clinicalJustification: draft.clinicalJustification }
        : {}),
    });

    // 4. Ledger rows (outbound + inbound) + transition queued → submitted.
    const outboundId = await this.prisma.runInTenantContext(
      input.tenantId,
      'tenant',
      async (tx) => {
        // Freeze the draft snapshot so a later edit doesn't change what
        // we believe we submitted.
        await tx.preauthDraft.update({
          where: { claimId: input.claimId },
          data: {
            submittedAt: new Date(),
            submittedSnapshot: pickDraft(draft) as never,
          },
        });
        const row = await this.integration.recordOutboundWithTx(tx, {
          tenantId: input.tenantId,
          claimId: input.claimId,
          integration: 'nhcx',
          operation: 'preauth.submit',
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
      operation: 'preauth.submit',
      claimId: input.claimId,
      rawResponse: adapterResult.rawResponse,
    });

    const snap = await this.claims.transition({
      tenantId: input.tenantId,
      claimId: input.claimId,
      eventType: 'preauth.acknowledged_by_payer',
      actorUserId: input.actorUserId,
      correlationId: adapterResult.correlationId,
      patch: { payerRefNum: adapterResult.payerRefNum, preauthRefNum: adapterResult.payerRefNum },
    });

    return {
      status: snap.status,
      payerRefNum: adapterResult.payerRefNum,
      correlationId: adapterResult.correlationId,
    };
  }

  // Admin escape hatch + the path Slice P's adapter callback eventually
  // wires through. Maps a payer decision onto the right state-machine
  // event.
  async applyDecision(input: DecisionInput): Promise<{
    status: string;
    approvedAmount: number | null;
  }> {
    const eventType =
      input.kind === 'approved'
        ? 'preauth.approved'
        : input.kind === 'rejected'
          ? 'preauth.rejected'
          : input.kind === 'partially_approved'
            ? 'preauth.partially_approved'
            : 'preauth.query_received';

    if (input.kind === 'query_received') {
      if (!input.queryText) {
        throw new ValidationFailedError({
          queryText: ['Required when kind is query_received.'],
        });
      }
      // Persist a PreauthQuery row + transition.
      const result = await this.prisma.runInTenantContext(
        input.tenantId,
        'tenant',
        async (tx) => {
          const q = await tx.preauthQuery.create({
            data: {
              tenantId: input.tenantId,
              claimId: input.claimId,
              queryText: input.queryText!,
            },
          });
          return q.id;
        },
      );
      void result;
      const snap = await this.claims.transition({
        tenantId: input.tenantId,
        claimId: input.claimId,
        eventType: 'preauth.query_received',
        actorUserId: input.actorUserId,
      });
      return { status: snap.status, approvedAmount: snap.approvedAmount };
    }

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

  async respondToQuery(input: QueryResponseInput): Promise<{ status: string }> {
    const claim = await this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      const q = await tx.preauthQuery.findUnique({ where: { id: input.queryId } });
      if (!q || q.tenantId !== input.tenantId || q.claimId !== input.claimId) {
        throw new ValidationFailedError({ queryId: ['Query not found on this claim.'] });
      }
      if (q.respondedAt) {
        throw new InvalidClaimTransitionError('Query already responded to.');
      }
      await tx.preauthQuery.update({
        where: { id: input.queryId },
        data: { respondedAt: new Date(), responseText: input.responseText },
      });
      return tx.claim.findUniqueOrThrow({ where: { id: input.claimId } });
    });
    const fhirCtx = await this.fhirContext.build(input.tenantId, input.claimId);
    const adapterResult = await this.nhcx.respondPreauthQuery({
      tenantId: input.tenantId,
      claimId: input.claimId,
      queryId: input.queryId,
      responseText: input.responseText,
      ...(fhirCtx.patient !== undefined ? { patient: fhirCtx.patient } : {}),
      ...(fhirCtx.coverage !== undefined ? { coverage: fhirCtx.coverage } : {}),
      ...(claim.preauthRefNum !== null ? { inReplyToRefNum: claim.preauthRefNum } : {}),
    });

    const outboundId = await this.prisma.runInTenantContext(
      input.tenantId,
      'tenant',
      async (tx) => {
        const row = await this.integration.recordOutboundWithTx(tx, {
          tenantId: input.tenantId,
          claimId: input.claimId,
          integration: 'nhcx',
          operation: 'preauth.query.respond',
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
      operation: 'preauth.query.respond',
      claimId: input.claimId,
      rawResponse: adapterResult.rawResponse,
    });

    const snap = await this.claims.transition({
      tenantId: input.tenantId,
      claimId: input.claimId,
      eventType: 'preauth.query_responded',
      actorUserId: input.actorUserId,
      correlationId: adapterResult.correlationId,
    });
    return { status: snap.status };
  }

  async getDraft(tenantId: string, claimId: string): Promise<PreauthDraftResponse | null> {
    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const row = await tx.preauthDraft.findUnique({ where: { claimId } });
      if (!row) return null;
      const claim = await tx.claim.findUnique({ where: { id: claimId }, select: { status: true } });
      return {
        draft: pickDraft(row),
        status: claim?.status ?? 'INITIATED',
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }
}

function pickDraft(row: {
  diagnosisIcdCode: string | null;
  diagnosisDescription: string | null;
  plannedProcedure: string | null;
  procedureCode: string | null;
  estimatedLengthOfStayDays: number | null;
  requestedAmount: number | null;
  clinicalJustification: string | null;
}): PreauthDraft {
  return {
    ...(row.diagnosisIcdCode !== null ? { diagnosisIcdCode: row.diagnosisIcdCode } : {}),
    ...(row.diagnosisDescription !== null ? { diagnosisDescription: row.diagnosisDescription } : {}),
    ...(row.plannedProcedure !== null ? { plannedProcedure: row.plannedProcedure } : {}),
    ...(row.procedureCode !== null ? { procedureCode: row.procedureCode } : {}),
    ...(row.estimatedLengthOfStayDays !== null ? { estimatedLengthOfStayDays: row.estimatedLengthOfStayDays } : {}),
    ...(row.requestedAmount !== null ? { requestedAmount: row.requestedAmount } : {}),
    ...(row.clinicalJustification !== null ? { clinicalJustification: row.clinicalJustification } : {}),
  };
}
