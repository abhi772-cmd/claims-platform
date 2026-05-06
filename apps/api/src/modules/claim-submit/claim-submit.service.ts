import {
  type ClaimDecisionKind,
  type ClaimSubmissionResponse,
} from '@claims/contracts';
import { Inject, Injectable } from '@nestjs/common';

import { ValidationFailedError } from '../../common/errors/validation-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ClaimService } from '../claim';
import { IntegrationMessageService } from '../integration';
import { NHCX_ADAPTER, type NhcxAdapter } from '../nhcx';

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

    // Adapter call.
    const adapter = await this.nhcx.submitClaim({
      tenantId: input.tenantId,
      claimId: input.claimId,
      finalAmount: input.finalAmount,
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
