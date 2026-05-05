import { Injectable } from '@nestjs/common';

import { ValidationFailedError } from '../../common/errors/validation-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ClaimService } from '../claim';
import { DocumentService } from '../document';
import { NhcxStubAdapter } from '../eligibility/nhcx-stub.adapter';
import { IntegrationMessageService } from '../integration';

export interface DischargeInput {
  tenantId: string;
  claimId: string;
  actorUserId: string;
}

@Injectable()
export class DischargeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly claims: ClaimService,
    private readonly documents: DocumentService,
    private readonly integration: IntegrationMessageService,
    private readonly nhcx: NhcxStubAdapter,
  ) {}

  async initiate(input: DischargeInput): Promise<{ status: string }> {
    const snap = await this.claims.transition({
      tenantId: input.tenantId,
      claimId: input.claimId,
      eventType: 'discharge.initiated',
      actorUserId: input.actorUserId,
    });
    return { status: snap.status };
  }

  async submit(input: DischargeInput): Promise<{ status: string }> {
    // Required-doc check: at least one discharge_summary on the claim.
    const hasSummary = await this.documents.hasDocumentType(
      input.tenantId,
      input.claimId,
      'discharge_summary',
    );
    if (!hasSummary) {
      throw new ValidationFailedError({
        documents: ['Upload a discharge_summary before submitting discharge.'],
      });
    }

    // Find the document ids for the bundle (so the audit trail captures
    // exactly what was sent).
    const docs = await this.documents.list(input.tenantId, input.claimId);
    const documentIds = docs.map((d) => d.id);

    const adapter = await this.nhcx.submitDischarge({
      tenantId: input.tenantId,
      claimId: input.claimId,
      documentIds,
    });

    const outboundId = await this.prisma.runInTenantContext(
      input.tenantId,
      'tenant',
      async (tx) => {
        const row = await this.integration.recordOutboundWithTx(tx, {
          tenantId: input.tenantId,
          claimId: input.claimId,
          integration: 'nhcx',
          operation: 'discharge.submit',
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
      operation: 'discharge.submit',
      claimId: input.claimId,
      rawResponse: adapter.rawResponse,
    });

    const snap = await this.claims.transition({
      tenantId: input.tenantId,
      claimId: input.claimId,
      eventType: 'discharge.submitted',
      actorUserId: input.actorUserId,
      correlationId: adapter.correlationId,
    });
    return { status: snap.status };
  }
}
