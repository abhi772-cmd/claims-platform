// Stage 9 — cross-claim NHCX status search.
//
// Pure-read service over integration_message + claim_event + claim,
// filtered by correlationId / claimRefNum / preauthRefNum. Used by
// the ops endpoint at GET /admin/nhcx/status-search.
//
// Tenant boundary: every query runs inside runInTenantContext so RLS
// enforces the tenant scope at the row level. The service does NOT
// re-check tenantId in the WHERE clause — that's the RLS policy's
// job. (Pattern: same as IntegrationMessageService.listForClaim.)

import {
  type IntegrationFailureClass,
  type IntegrationMessage,
  type IntegrationName,
  type NhcxStatusSearchClaim,
  type NhcxStatusSearchEvent,
  type NhcxStatusSearchResponse,
} from '@claims/contracts';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';

export interface SearchInput {
  tenantId: string;
  correlationId?: string;
  claimRefNum?: string;
  preauthRefNum?: string;
}

@Injectable()
export class NhcxStatusSearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(input: SearchInput): Promise<NhcxStatusSearchResponse> {
    return this.prisma.runInTenantContext(input.tenantId, 'tenant', async (tx) => {
      // Step 1 — find claim ids that match the ref-num filters. We
      // collect a single set of "candidate claim ids" so the
      // integration-messages and claim-events queries can scope by
      // claim membership when the user filtered by a ref num. When
      // the user only supplied correlationId, candidateClaimIds is
      // null and the queries use only the correlationId filter.
      let candidateClaimIds: string[] | null = null;
      if (input.claimRefNum || input.preauthRefNum) {
        const orFilters: Array<Record<string, string>> = [];
        if (input.claimRefNum) orFilters.push({ claimRefNum: input.claimRefNum });
        if (input.preauthRefNum) orFilters.push({ preauthRefNum: input.preauthRefNum });
        const matchingClaims = await tx.claim.findMany({
          where: { OR: orFilters },
          select: { id: true },
        });
        candidateClaimIds = matchingClaims.map((c) => c.id);
        // If the user gave a ref num that matched nothing, short-
        // circuit the rest — there's no point widening to a global
        // correlationId-only search when they were specific about
        // the ref num.
        if (candidateClaimIds.length === 0) {
          return {
            query: {
              correlationId: input.correlationId ?? null,
              claimRefNum: input.claimRefNum ?? null,
              preauthRefNum: input.preauthRefNum ?? null,
            },
            integrationMessages: [],
            claimEvents: [],
            claims: [],
          };
        }
      }

      // Step 2 — integration_message lookup. The two filters compose
      // with AND: correlationId AND claimId-in-candidates.
      const integrationMessages = await tx.integrationMessage.findMany({
        where: {
          ...(input.correlationId ? { correlationId: input.correlationId } : {}),
          ...(candidateClaimIds ? { claimId: { in: candidateClaimIds } } : {}),
        },
        orderBy: { createdAt: 'asc' },
      });

      // Step 3 — claim_event lookup. Same composition rule. Events
      // store the correlation as a single column, so the OR
      // behaviour (find events for refnum claims that ALSO have a
      // matching correlationId) is the intersection — exactly what
      // AND produces.
      const claimEvents = await tx.claimEvent.findMany({
        where: {
          ...(input.correlationId ? { correlationId: input.correlationId } : {}),
          ...(candidateClaimIds ? { claimId: { in: candidateClaimIds } } : {}),
        },
        orderBy: { occurredAt: 'asc' },
        select: {
          id: true,
          claimId: true,
          eventType: true,
          resultingStatus: true,
          occurredAt: true,
          correlationId: true,
        },
      });

      // Step 4 — gather the distinct claims touched by either result
      // set. Ops user needs the current status + ref nums to decide
      // whether the claim needs manual intervention.
      const touchedClaimIds = new Set<string>();
      for (const m of integrationMessages) {
        if (m.claimId) touchedClaimIds.add(m.claimId);
      }
      for (const e of claimEvents) {
        touchedClaimIds.add(e.claimId);
      }
      // Also include candidates that matched a ref num filter even
      // when they had no events / messages (shouldn't happen often
      // but is informative when it does — claim exists but no
      // gateway traffic, suggests local-only state).
      if (candidateClaimIds) {
        for (const id of candidateClaimIds) touchedClaimIds.add(id);
      }

      const claims: NhcxStatusSearchClaim[] = [];
      if (touchedClaimIds.size > 0) {
        const claimRows = await tx.claim.findMany({
          where: { id: { in: Array.from(touchedClaimIds) } },
          select: {
            id: true,
            caseId: true,
            status: true,
            preauthRefNum: true,
            claimRefNum: true,
            payerRefNum: true,
          },
        });
        for (const c of claimRows) {
          claims.push({
            claimId: c.id,
            caseId: c.caseId,
            status: c.status,
            preauthRefNum: c.preauthRefNum,
            claimRefNum: c.claimRefNum,
            payerRefNum: c.payerRefNum,
          });
        }
      }

      return {
        query: {
          correlationId: input.correlationId ?? null,
          claimRefNum: input.claimRefNum ?? null,
          preauthRefNum: input.preauthRefNum ?? null,
        },
        integrationMessages: integrationMessages.map((m): IntegrationMessage => ({
          id: m.id,
          direction: m.direction as IntegrationMessage['direction'],
          integration: m.integration as IntegrationName,
          operation: m.operation,
          correlationId: m.correlationId,
          status: m.status as IntegrationMessage['status'],
          failureClass: (m.failureClass as IntegrationFailureClass | null) ?? null,
          retryCount: m.retryCount,
          createdAt: m.createdAt.toISOString(),
          completedAt: m.completedAt ? m.completedAt.toISOString() : null,
          rawRequest: m.rawRequest as unknown,
          rawResponse: m.rawResponse as unknown,
        })),
        claimEvents: claimEvents.map((e): NhcxStatusSearchEvent => ({
          id: e.id,
          claimId: e.claimId,
          eventType: e.eventType,
          resultingStatus: e.resultingStatus,
          occurredAt: e.occurredAt.toISOString(),
          correlationId: e.correlationId,
        })),
        claims,
      };
    });
  }
}
