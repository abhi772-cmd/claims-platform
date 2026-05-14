import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ValidationFailedError } from '../../common/errors/validation-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { type AppConfig } from '../../config/configuration';
import { ClaimService } from '../claim';
import { DocumentService } from '../document';
import { IntegrationMessageService } from '../integration';
import { FhirContextService, NHCX_ADAPTER, type NhcxAdapter } from '../nhcx';

export interface DischargeInput {
  tenantId: string;
  claimId: string;
  actorUserId: string;
}

@Injectable()
export class DischargeService {
  private readonly log = new Logger(DischargeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly claims: ClaimService,
    private readonly documents: DocumentService,
    private readonly integration: IntegrationMessageService,
    private readonly fhirContext: FhirContextService,
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(NHCX_ADAPTER) private readonly nhcx: NhcxAdapter,
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

    const fhirCtx = await this.fhirContext.build(input.tenantId, input.claimId, {
      actorUserId: input.actorUserId,
      actorType: 'user',
      purpose: 'discharge.submit',
    });
    // HCX correlation chain (doc 07 lines 99–117). Discharge chains
    // off the most recent preauth-side correlation (enhancement
    // when one ran, else the original preauth).
    const claimRow = await this.prisma.runInTenantContext(
      input.tenantId,
      'tenant',
      (tx) =>
        tx.claim.findUniqueOrThrow({
          where: { id: input.claimId },
          select: {
            enhancementCorrelationId: true,
            preauthCorrelationId: true,
          },
        }),
    );
    const parentCorrelationId =
      claimRow.enhancementCorrelationId ?? claimRow.preauthCorrelationId ?? undefined;
    const adapter = await this.nhcx.submitDischarge({
      tenantId: input.tenantId,
      claimId: input.claimId,
      documentIds,
      ...(parentCorrelationId ? { parentCorrelationId } : {}),
      ...(fhirCtx.patient !== undefined ? { patient: fhirCtx.patient } : {}),
      ...(fhirCtx.coverage !== undefined ? { coverage: fhirCtx.coverage } : {}),
    });

    const outboundId = await this.prisma.runInTenantContext(
      input.tenantId,
      'tenant',
      async (tx) => {
        // Stamp dischargeCorrelationId so claim/submit can read it
        // back as its parentCorrelationId.
        await tx.claim.update({
          where: { id: input.claimId },
          data: { dischargeCorrelationId: adapter.correlationId },
        });
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

    // Slice AF: real mode = the gateway will POST a communication/
    // request callback (HCX 0.7.1's discharge ack flows through the
    // Communication operation). Stop at DISCHARGE_PENDING here; the
    // inbound dispatcher's discharge handler runs the
    // discharge.submitted transition. Single-step, no decision.
    if (this.config.get('NHCX_MODE', { infer: true }) === 'real') {
      const pendingSnap = await this.prisma.runInTenantContext(
        input.tenantId,
        'platform_admin',
        (tx) => tx.claim.findUniqueOrThrow({ where: { id: input.claimId } }),
      );
      void outboundId;
      return { status: pendingSnap.status };
    }

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

  // Slice AF entry point. Called by NhcxInboundService when a
  // communication/request callback arrives whose matching outbound
  // was a discharge.submit. Single state-machine step:
  // DISCHARGE_PENDING → DISCHARGE_SUBMITTED. Idempotent: skips when
  // the claim is already past PENDING.
  async handleInboundResponse(input: {
    tenantId: string;
    claimId: string;
    correlationId: string;
  }): Promise<{ status: string }> {
    const claim = await this.prisma.runInTenantContext(
      input.tenantId,
      'platform_admin',
      (tx) => tx.claim.findUniqueOrThrow({ where: { id: input.claimId } }),
    );
    if (claim.status !== 'DISCHARGE_PENDING') {
      this.log.log(
        `discharge inbound — claim ${input.claimId} already at ${claim.status}; skipping transition`,
      );
      return { status: claim.status };
    }
    const snap = await this.claims.transition({
      tenantId: input.tenantId,
      claimId: input.claimId,
      eventType: 'discharge.submitted',
      actorUserId: null,
      correlationId: input.correlationId,
    });
    return { status: snap.status };
  }
}
