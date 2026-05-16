// Stage 9 — NhcxStatusSearchService unit tests.
//
// Mocks PrismaService so we exercise the composition logic (filter
// shape, candidate-claim short-circuit, distinct claim aggregation,
// row-to-contract mapping) without standing up Postgres.

import { NhcxStatusSearchQuerySchema } from '@claims/contracts';

import { NhcxStatusSearchService } from './nhcx-status-search.service';

// Build a PrismaService stand-in. runInTenantContext is the only
// entry point the service uses; we hand it a fake tx with the
// three model accessors the service touches.
function makePrismaStub(rows: {
  claim?: Array<{
    id: string;
    caseId: string;
    status: string;
    preauthRefNum: string | null;
    claimRefNum: string | null;
    payerRefNum: string | null;
  }>;
  integrationMessage?: Array<{
    id: string;
    claimId: string | null;
    direction: 'outbound' | 'inbound';
    integration: 'nhcx';
    operation: string;
    correlationId: string;
    status: 'succeeded' | 'failed' | 'pending';
    failureClass: string | null;
    retryCount: number;
    createdAt: Date;
    completedAt: Date | null;
    rawRequest: unknown;
    rawResponse: unknown;
  }>;
  claimEvent?: Array<{
    id: string;
    claimId: string;
    eventType: string;
    resultingStatus: string;
    occurredAt: Date;
    correlationId: string | null;
  }>;
}) {
  const claimFindMany = jest.fn().mockImplementation(({ where }: { where: Record<string, unknown> }) => {
    let result = rows.claim ?? [];
    if (where['OR']) {
      const ors = where['OR'] as Array<Record<string, string>>;
      result = result.filter((c) =>
        ors.some((f) =>
          Object.entries(f).every(([k, v]) => (c as unknown as Record<string, string>)[k] === v),
        ),
      );
    }
    if (where['id']) {
      const ids = (where['id'] as { in: string[] }).in;
      result = result.filter((c) => ids.includes(c.id));
    }
    return Promise.resolve(result);
  });

  const integrationFindMany = jest
    .fn()
    .mockImplementation(({ where }: { where: Record<string, unknown> }) => {
      let result = rows.integrationMessage ?? [];
      if (where['correlationId']) {
        result = result.filter((m) => m.correlationId === where['correlationId']);
      }
      if (where['claimId']) {
        const ids = (where['claimId'] as { in: string[] }).in;
        result = result.filter((m) => m.claimId !== null && ids.includes(m.claimId));
      }
      return Promise.resolve(result);
    });

  const eventFindMany = jest
    .fn()
    .mockImplementation(({ where }: { where: Record<string, unknown> }) => {
      let result = rows.claimEvent ?? [];
      if (where['correlationId']) {
        result = result.filter((e) => e.correlationId === where['correlationId']);
      }
      if (where['claimId']) {
        const ids = (where['claimId'] as { in: string[] }).in;
        result = result.filter((e) => ids.includes(e.claimId));
      }
      return Promise.resolve(result);
    });

  const tx = {
    claim: { findMany: claimFindMany },
    integrationMessage: { findMany: integrationFindMany },
    claimEvent: { findMany: eventFindMany },
  };

  const prisma = {
    runInTenantContext: jest.fn().mockImplementation((_tenantId: string, _role: string, cb: (tx: unknown) => unknown) =>
      Promise.resolve(cb(tx)),
    ),
  };

  return { prisma, claimFindMany, integrationFindMany, eventFindMany };
}

const NOW = new Date('2026-05-16T20:00:00.000Z');

describe('NhcxStatusSearchService', () => {
  describe('query schema validation', () => {
    it('rejects an empty query', () => {
      const r = NhcxStatusSearchQuerySchema.safeParse({});
      expect(r.success).toBe(false);
    });

    it('accepts correlationId only', () => {
      expect(
        NhcxStatusSearchQuerySchema.safeParse({ correlationId: 'corr-1' }).success,
      ).toBe(true);
    });

    it('accepts claimRefNum only', () => {
      expect(
        NhcxStatusSearchQuerySchema.safeParse({ claimRefNum: 'CR-1' }).success,
      ).toBe(true);
    });

    it('accepts preauthRefNum only', () => {
      expect(
        NhcxStatusSearchQuerySchema.safeParse({ preauthRefNum: 'PR-1' }).success,
      ).toBe(true);
    });

    it('accepts all three together', () => {
      expect(
        NhcxStatusSearchQuerySchema.safeParse({
          correlationId: 'corr-1',
          claimRefNum: 'CR-1',
          preauthRefNum: 'PR-1',
        }).success,
      ).toBe(true);
    });
  });

  describe('service composition', () => {
    it('returns matching integration messages + claim events + the touched claim when filtering by correlationId only', async () => {
      const { prisma, claimFindMany } = makePrismaStub({
        claim: [
          {
            id: 'claim-1',
            caseId: 'case-1',
            status: 'PREAUTH_QUEUED',
            preauthRefNum: 'PR-1',
            claimRefNum: null,
            payerRefNum: null,
          },
        ],
        integrationMessage: [
          {
            id: 'msg-1',
            claimId: 'claim-1',
            direction: 'outbound',
            integration: 'nhcx',
            operation: 'preauth.submit',
            correlationId: 'corr-1',
            status: 'succeeded',
            failureClass: null,
            retryCount: 0,
            createdAt: NOW,
            completedAt: NOW,
            rawRequest: { foo: 'bar' },
            rawResponse: { ok: true },
          },
        ],
        claimEvent: [
          {
            id: 'evt-1',
            claimId: 'claim-1',
            eventType: 'preauth.submitted_internally',
            resultingStatus: 'PREAUTH_QUEUED',
            occurredAt: NOW,
            correlationId: 'corr-1',
          },
        ],
      });
      const svc = new NhcxStatusSearchService(prisma as never);
      const out = await svc.search({ tenantId: 'tenant-1', correlationId: 'corr-1' });
      // No ref-num filter → claim.findMany must NOT be called for the
      // candidate-resolution step (the service only calls it later to
      // resolve touched-claim metadata).
      expect(claimFindMany).toHaveBeenCalledTimes(1);
      expect(out.integrationMessages).toHaveLength(1);
      expect(out.integrationMessages[0]!.correlationId).toBe('corr-1');
      expect(out.claimEvents).toHaveLength(1);
      expect(out.claims).toEqual([
        {
          claimId: 'claim-1',
          caseId: 'case-1',
          status: 'PREAUTH_QUEUED',
          preauthRefNum: 'PR-1',
          claimRefNum: null,
          payerRefNum: null,
        },
      ]);
      expect(out.query).toEqual({
        correlationId: 'corr-1',
        claimRefNum: null,
        preauthRefNum: null,
      });
    });

    it('short-circuits when claimRefNum/preauthRefNum match no claims (does not widen to a global correlationId-only search)', async () => {
      const { prisma, integrationFindMany, eventFindMany } = makePrismaStub({
        claim: [],
        integrationMessage: [
          {
            id: 'msg-orphan',
            claimId: null,
            direction: 'outbound',
            integration: 'nhcx',
            operation: 'eligibility.verify',
            correlationId: 'corr-1',
            status: 'succeeded',
            failureClass: null,
            retryCount: 0,
            createdAt: NOW,
            completedAt: NOW,
            rawRequest: null,
            rawResponse: null,
          },
        ],
      });
      const svc = new NhcxStatusSearchService(prisma as never);
      const out = await svc.search({
        tenantId: 'tenant-1',
        correlationId: 'corr-1',
        claimRefNum: 'CR-MISSING',
      });
      expect(out.integrationMessages).toEqual([]);
      expect(out.claimEvents).toEqual([]);
      expect(out.claims).toEqual([]);
      // The integration/event findMany calls must be skipped entirely
      // when the ref-num candidate set is empty.
      expect(integrationFindMany).not.toHaveBeenCalled();
      expect(eventFindMany).not.toHaveBeenCalled();
    });

    it('includes a candidate-by-refnum claim even when it has no integration messages or events (local-only state)', async () => {
      const { prisma } = makePrismaStub({
        claim: [
          {
            id: 'claim-2',
            caseId: 'case-2',
            status: 'INITIATED',
            preauthRefNum: null,
            claimRefNum: 'CR-2',
            payerRefNum: null,
          },
        ],
        integrationMessage: [],
        claimEvent: [],
      });
      const svc = new NhcxStatusSearchService(prisma as never);
      const out = await svc.search({ tenantId: 'tenant-1', claimRefNum: 'CR-2' });
      expect(out.integrationMessages).toEqual([]);
      expect(out.claimEvents).toEqual([]);
      expect(out.claims).toHaveLength(1);
      expect(out.claims[0]!.claimRefNum).toBe('CR-2');
    });

    it('composes correlationId AND ref-num filters (intersection)', async () => {
      const { prisma } = makePrismaStub({
        claim: [
          {
            id: 'claim-3',
            caseId: 'case-3',
            status: 'CLAIM_QUEUED',
            preauthRefNum: 'PR-3',
            claimRefNum: 'CR-3',
            payerRefNum: null,
          },
        ],
        integrationMessage: [
          {
            id: 'msg-a',
            claimId: 'claim-3',
            direction: 'outbound',
            integration: 'nhcx',
            operation: 'claim.submit',
            correlationId: 'corr-3',
            status: 'succeeded',
            failureClass: null,
            retryCount: 0,
            createdAt: NOW,
            completedAt: NOW,
            rawRequest: null,
            rawResponse: null,
          },
          {
            id: 'msg-b',
            claimId: 'claim-3',
            direction: 'outbound',
            integration: 'nhcx',
            operation: 'preauth.submit',
            correlationId: 'corr-OTHER',
            status: 'succeeded',
            failureClass: null,
            retryCount: 0,
            createdAt: NOW,
            completedAt: NOW,
            rawRequest: null,
            rawResponse: null,
          },
        ],
        claimEvent: [],
      });
      const svc = new NhcxStatusSearchService(prisma as never);
      const out = await svc.search({
        tenantId: 'tenant-1',
        correlationId: 'corr-3',
        claimRefNum: 'CR-3',
      });
      // Only msg-a survives the AND of (correlationId=corr-3) AND
      // (claimId in [claim-3]); msg-b is dropped on correlation.
      expect(out.integrationMessages.map((m) => m.id)).toEqual(['msg-a']);
    });
  });
});
