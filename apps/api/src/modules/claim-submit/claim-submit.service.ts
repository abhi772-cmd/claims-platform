import {
  type ClaimDecisionKind,
  type ClaimSubmissionResponse,
} from '@claims/contracts';
import { Inject, Injectable } from '@nestjs/common';

import { ValidationFailedError } from '../../common/errors/validation-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ClaimService } from '../claim';
import { DocumentService } from '../document';
import { IntegrationMessageService } from '../integration';
import { FhirContextService, NHCX_ADAPTER, type NhcxAdapter } from '../nhcx';

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

@Injectable()
export class ClaimSubmitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly claims: ClaimService,
    private readonly integration: IntegrationMessageService,
    private readonly documents: DocumentService,
    private readonly fhirContext: FhirContextService,
    @Inject(NHCX_ADAPTER) private readonly nhcx: NhcxAdapter,
  ) {}

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
    const fhirCtx = await this.fhirContext.build(input.tenantId, input.claimId);
    const draft = await this.prisma.runInTenantContext(input.tenantId, 'tenant', (tx) =>
      tx.preauthDraft.findUnique({ where: { claimId: input.claimId } }),
    );
    const docs = await this.documents.list(input.tenantId, input.claimId);
    const adapter = await this.nhcx.submitClaim({
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
    });

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
}
