// `insuranceplan/request` orchestrator.
//
// This is the head of the NHCX HCX correlation chain (doc 07 lines
// 99–117 / GAP_ANALYSIS.md row 1.13). The hospital sends the payer a
// TaskBundle carrying a policy number + provider id; the payer
// responds asynchronously on `insuranceplan/on_request` with an
// InsurancePlan resource the operator can review before opening a
// claim.
//
// Why this service is intentionally thin:
//   - Unlike eligibility/preauth/claim it does NOT drive a state-
//     machine transition. A policy lookup is metadata enrichment,
//     not a claim event.
//   - It DOES stamp `claim.insuranceCorrelationId` when called with
//     a claimId so every later stage (coverage, preauth, discharge,
//     claim, payment) inherits the correlation id on the wire.
//   - It DOES write outbound + inbound integration_message ledger
//     rows so ops can audit the lookup end-to-end like any other
//     NHCX call.

import { Inject, Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';
import { IntegrationMessageService } from '../integration';
import {
  type AdapterInsurancePlanRequestInput,
  NHCX_ADAPTER,
  type NhcxAdapter,
} from '../nhcx';

export interface RequestInsurancePlanInput {
  tenantId: string;
  // Optional — set when the lookup is tied to an in-flight claim row.
  // The chain only threads forward when this is present; freestanding
  // lookups (pre-admission policy verification, walk-in patient at OPD)
  // still hit the wire correctly but no Claim row gets stamped.
  claimId?: string;
  payerCode: string;
  policyNumber: string;
  providerId: string;
  // Optional display strings forwarded to the FHIR Organization
  // resources on the outbound bundle.
  payerDisplayName?: string;
  hospitalDisplayName?: string;
  actorUserId: string;
}

export interface RequestInsurancePlanResult {
  correlationId: string;
  acknowledged: boolean;
}

// Shape returned by `recordResponse` / `findByCorrelationId` /
// `findLatestForClaim`. Mirrors the columns on the
// `insurance_plan_lookup` table that the operator UI / read API
// surfaces. The two date columns are emitted as ISO 8601 strings so
// the controller doesn't have to re-serialise.
export interface InsurancePlanLookupView {
  id: string;
  correlationId: string;
  claimId: string | null;
  payerCode: string;
  policyNumber: string;
  providerId: string;
  status: 'pending' | 'resolved' | 'failed';
  planId: string | null;
  planName: string | null;
  planStatus: string | null;
  planType: string | null;
  sumInsuredPaise: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  network: string | null;
  failureReason: string | null;
  requestedAt: string;
  resolvedAt: string | null;
}

// What the inbound dispatcher passes when the `insuranceplan/on_request`
// callback arrives. All response fields are optional — different
// payers ship different subsets, and we accept whichever lands.
export interface RecordInsurancePlanResponseInput {
  tenantId: string;
  correlationId: string;
  outcome: 'resolved' | 'failed';
  failureReason?: string;
  planId?: string;
  planName?: string;
  planStatus?: string;
  planType?: string;
  sumInsuredPaise?: number;
  periodStart?: string;
  periodEnd?: string;
  network?: string;
}

@Injectable()
export class InsurancePlanService {
  private readonly log = new Logger(InsurancePlanService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly integration: IntegrationMessageService,
    @Inject(NHCX_ADAPTER) private readonly nhcx: NhcxAdapter,
  ) {}

  async request(input: RequestInsurancePlanInput): Promise<RequestInsurancePlanResult> {
    const adapterInput: AdapterInsurancePlanRequestInput = {
      tenantId: input.tenantId,
      ...(input.claimId !== undefined ? { claimId: input.claimId } : {}),
      payerCode: input.payerCode,
      policyNumber: input.policyNumber,
      providerId: input.providerId,
      ...(input.payerDisplayName !== undefined
        ? { payerDisplayName: input.payerDisplayName }
        : {}),
      ...(input.hospitalDisplayName !== undefined
        ? { hospitalDisplayName: input.hospitalDisplayName }
        : {}),
    };
    const adapterResult = await this.nhcx.requestInsurancePlan(adapterInput);

    // Ledger write + chain stamp + lookup row. All three happen in
    // one tx so a partial failure can't leave the system in a state
    // where (a) the Claim row is stamped but the ledger is missing,
    // (b) the ledger says we made the call but no lookup row exists
    // for ops to see, or (c) a freestanding lookup leaks without a
    // ledger entry. The inbound dispatcher then updates the lookup
    // row by correlationId when the on_request callback lands.
    const outboundId = await this.prisma.runInTenantContext(
      input.tenantId,
      'tenant',
      async (tx) => {
        if (input.claimId) {
          await tx.claim.update({
            where: { id: input.claimId },
            data: { insuranceCorrelationId: adapterResult.correlationId },
          });
        }
        await tx.insurancePlanLookup.create({
          data: {
            tenantId: input.tenantId,
            ...(input.claimId ? { claimId: input.claimId } : {}),
            correlationId: adapterResult.correlationId,
            payerCode: input.payerCode,
            policyNumber: input.policyNumber,
            providerId: input.providerId,
            requestedByUserId: input.actorUserId,
            status: 'pending',
          },
        });
        const row = await this.integration.recordOutboundWithTx(tx, {
          tenantId: input.tenantId,
          ...(input.claimId ? { claimId: input.claimId } : {}),
          integration: 'nhcx',
          operation: 'insuranceplan.request',
          correlationId: adapterResult.correlationId,
          rawRequest: adapterResult.rawRequest,
        });
        return row.id;
      },
    );

    // In real-mode the response payload arrives later on the
    // `insuranceplan/on_request` callback — the gateway returns just a
    // sync ack. The stub adapter returns a fake preview synchronously
    // (and the JWE adapter materialises whatever the gateway sends),
    // so we mark the outbound succeeded in both paths and the inbound
    // dispatcher upgrades the parsed plan data when the callback lands.
    await this.integration.markSucceeded({
      tenantId: input.tenantId,
      outboundId,
      correlationId: adapterResult.correlationId,
      integration: 'nhcx',
      operation: 'insuranceplan.request',
      ...(input.claimId ? { claimId: input.claimId } : {}),
      rawResponse: adapterResult.rawResponse,
    });

    this.log.log(
      `insuranceplan/request tenantId=${input.tenantId} claimId=${input.claimId ?? '<none>'} ` +
        `policy=${input.policyNumber} ack=${adapterResult.acknowledged} correlationId=${adapterResult.correlationId}`,
    );
    return {
      correlationId: adapterResult.correlationId,
      acknowledged: adapterResult.acknowledged,
    };
  }

  // Called by the inbound dispatcher when `insuranceplan/on_request`
  // arrives. Updates the pending row by correlationId and sets
  // status to 'resolved' (or 'failed' when the payer signalled a
  // not-found / error outcome). Idempotent — re-running with the
  // same correlation id is a no-op when the row is already resolved,
  // so the dispatcher can retry the parse without producing stale
  // ledger churn.
  async recordResponse(input: RecordInsurancePlanResponseInput): Promise<InsurancePlanLookupView | null> {
    const row = await this.prisma.runInTenantContext(
      input.tenantId,
      'tenant',
      async (tx) => {
        const existing = await tx.insurancePlanLookup.findUnique({
          where: { correlationId: input.correlationId },
        });
        if (!existing) {
          this.log.warn(
            `insuranceplan/on_request correlationId=${input.correlationId} has no matching outbound lookup row — out-of-band callback?`,
          );
          return null;
        }
        if (existing.status === 'resolved' || existing.status === 'failed') {
          // Already terminal — preserve the original resolution and
          // don't churn the row. Same shape returned for visibility.
          return existing;
        }
        return tx.insurancePlanLookup.update({
          where: { correlationId: input.correlationId },
          data: {
            status: input.outcome,
            resolvedAt: new Date(),
            ...(input.failureReason !== undefined
              ? { failureReason: input.failureReason }
              : {}),
            ...(input.planId !== undefined ? { planId: input.planId } : {}),
            ...(input.planName !== undefined ? { planName: input.planName } : {}),
            ...(input.planStatus !== undefined ? { planStatus: input.planStatus } : {}),
            ...(input.planType !== undefined ? { planType: input.planType } : {}),
            ...(input.sumInsuredPaise !== undefined
              ? { sumInsuredPaise: input.sumInsuredPaise }
              : {}),
            ...(input.periodStart !== undefined ? { periodStart: input.periodStart } : {}),
            ...(input.periodEnd !== undefined ? { periodEnd: input.periodEnd } : {}),
            ...(input.network !== undefined ? { network: input.network } : {}),
          },
        });
      },
    );
    return row ? toView(row) : null;
  }

  async findByCorrelationId(
    tenantId: string,
    correlationId: string,
  ): Promise<InsurancePlanLookupView | null> {
    const row = await this.prisma.runInTenantContext(tenantId, 'tenant', (tx) =>
      tx.insurancePlanLookup.findUnique({ where: { correlationId } }),
    );
    return row ? toView(row) : null;
  }

  async findLatestForClaim(
    tenantId: string,
    claimId: string,
  ): Promise<InsurancePlanLookupView | null> {
    const row = await this.prisma.runInTenantContext(tenantId, 'tenant', (tx) =>
      tx.insurancePlanLookup.findFirst({
        where: { claimId },
        orderBy: { requestedAt: 'desc' },
      }),
    );
    return row ? toView(row) : null;
  }
}

// Prisma row → view shape. The Prisma client's Date fields become
// ISO strings, nullable fields stay nullable. Centralising this in
// one place keeps the controller from leaking Prisma types into the
// HTTP boundary.
function toView(row: {
  id: string;
  correlationId: string;
  claimId: string | null;
  payerCode: string;
  policyNumber: string;
  providerId: string;
  status: string;
  planId: string | null;
  planName: string | null;
  planStatus: string | null;
  planType: string | null;
  sumInsuredPaise: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  network: string | null;
  failureReason: string | null;
  requestedAt: Date;
  resolvedAt: Date | null;
}): InsurancePlanLookupView {
  return {
    id: row.id,
    correlationId: row.correlationId,
    claimId: row.claimId,
    payerCode: row.payerCode,
    policyNumber: row.policyNumber,
    providerId: row.providerId,
    status: row.status as 'pending' | 'resolved' | 'failed',
    planId: row.planId,
    planName: row.planName,
    planStatus: row.planStatus,
    planType: row.planType,
    sumInsuredPaise: row.sumInsuredPaise,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    network: row.network,
    failureReason: row.failureReason,
    requestedAt: row.requestedAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  };
}
