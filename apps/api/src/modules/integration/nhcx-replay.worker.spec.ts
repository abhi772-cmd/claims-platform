// T1-5 — NhcxReplayWorker unit tests. Mocks IntegrationMessageService
// and exercises the worker's dispatch + outcome handling in isolation.

import { type IntegrationFailureClass } from '@claims/contracts';
import type { ConfigService } from '@nestjs/config';

import {
  NhcxReplayWorker,
  type ReplayContext,
  type ReplayHandler,
  type ReplayOutcome,
} from './nhcx-replay.worker';

// Minimal stand-in for the bits of IntegrationMessageService the
// worker touches. Spies record calls; behaviour is set per-test.
function makeIntegrationStub() {
  const findReplayable = jest.fn();
  const markQueuedForRetry = jest.fn();
  const markReplayExhausted = jest.fn();
  return {
    integration: { findReplayable, markQueuedForRetry, markReplayExhausted } as unknown,
    findReplayable,
    markQueuedForRetry,
    markReplayExhausted,
  };
}

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const map = new Map<string, unknown>(Object.entries(overrides));
  return {
    get: (key: string): unknown => map.get(key),
  } as unknown as ConfigService;
}

const ROW = {
  id: 'outbound-1',
  tenantId: 'tenant-1',
  claimId: 'claim-1',
  integration: 'nhcx',
  operation: 'eligibility.verify',
  correlationId: 'corr-1',
  retryCount: 0,
  idempotencyKey: 'idem-1',
};

describe('NhcxReplayWorker', () => {
  it('registers a handler and reports it', () => {
    const stub = makeIntegrationStub();
    const worker = new NhcxReplayWorker(
      stub.integration as never,
      makeConfig({ NHCX_REPLAY_DISABLED: '1' }),
    );
    const handler: ReplayHandler = {
      operation: 'eligibility.verify',
      handle: async () => 'succeeded' as ReplayOutcome,
    };
    worker.registerHandler(handler);
    expect(worker.registeredOperations()).toEqual(['eligibility.verify']);
  });

  it('ignores a duplicate registration for the same operation', () => {
    const stub = makeIntegrationStub();
    const worker = new NhcxReplayWorker(
      stub.integration as never,
      makeConfig({ NHCX_REPLAY_DISABLED: '1' }),
    );
    worker.registerHandler({
      operation: 'eligibility.verify',
      handle: async () => 'succeeded',
    });
    worker.registerHandler({
      operation: 'eligibility.verify',
      handle: async () => 'permanent',
    });
    expect(worker.registeredOperations()).toEqual(['eligibility.verify']);
  });

  it('skips rows whose operation has no registered handler', async () => {
    const stub = makeIntegrationStub();
    stub.findReplayable.mockResolvedValue([ROW]);
    const worker = new NhcxReplayWorker(
      stub.integration as never,
      makeConfig({ NHCX_REPLAY_DISABLED: '1' }),
    );
    const result = await worker.runOnce();
    expect(result).toEqual({
      processed: 0,
      succeeded: 0,
      reparked: 0,
      permanent: 0,
      skipped: 1,
    });
    expect(stub.markQueuedForRetry).not.toHaveBeenCalled();
    expect(stub.markReplayExhausted).not.toHaveBeenCalled();
  });

  it('counts succeeded outcome and does NOT call back into the integration service', async () => {
    // Handlers are responsible for calling markReplaySucceeded
    // themselves before returning 'succeeded'. The worker just
    // tallies the outcome.
    const stub = makeIntegrationStub();
    stub.findReplayable.mockResolvedValue([ROW]);
    const handler: ReplayHandler = {
      operation: 'eligibility.verify',
      handle: jest.fn(async (ctx: ReplayContext): Promise<ReplayOutcome> => {
        expect(ctx.outboundId).toBe('outbound-1');
        expect(ctx.tenantId).toBe('tenant-1');
        expect(ctx.claimId).toBe('claim-1');
        expect(ctx.idempotencyKey).toBe('idem-1');
        return 'succeeded';
      }),
    };
    const worker = new NhcxReplayWorker(
      stub.integration as never,
      makeConfig({ NHCX_REPLAY_DISABLED: '1' }),
    );
    worker.registerHandler(handler);
    const result = await worker.runOnce();
    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(stub.markQueuedForRetry).not.toHaveBeenCalled();
    expect(stub.markReplayExhausted).not.toHaveBeenCalled();
  });

  it('re-parks the row with incremented attempt count on transient outcome', async () => {
    const stub = makeIntegrationStub();
    stub.findReplayable.mockResolvedValue([{ ...ROW, retryCount: 2 }]);
    const worker = new NhcxReplayWorker(
      stub.integration as never,
      makeConfig({ NHCX_REPLAY_DISABLED: '1' }),
    );
    worker.registerHandler({
      operation: 'eligibility.verify',
      handle: async () => 'transient' as ReplayOutcome,
    });
    const result = await worker.runOnce();
    expect(result.reparked).toBe(1);
    expect(stub.markQueuedForRetry).toHaveBeenCalledTimes(1);
    expect(stub.markQueuedForRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        outboundId: 'outbound-1',
        tenantId: 'tenant-1',
        attemptsSoFar: 3, // row.retryCount(2) + 1
        failureClass: 'network',
      }),
    );
  });

  it('marks the row exhausted on permanent outcome', async () => {
    const stub = makeIntegrationStub();
    stub.findReplayable.mockResolvedValue([ROW]);
    const worker = new NhcxReplayWorker(
      stub.integration as never,
      makeConfig({ NHCX_REPLAY_DISABLED: '1' }),
    );
    worker.registerHandler({
      operation: 'eligibility.verify',
      handle: async () => 'permanent' as ReplayOutcome,
    });
    const result = await worker.runOnce();
    expect(result.permanent).toBe(1);
    expect(stub.markReplayExhausted).toHaveBeenCalledWith(
      expect.objectContaining({
        outboundId: 'outbound-1',
        tenantId: 'tenant-1',
        failureClass: expect.any(String) as IntegrationFailureClass,
      }),
    );
  });

  it('treats handler exceptions as transient (re-parks)', async () => {
    const stub = makeIntegrationStub();
    stub.findReplayable.mockResolvedValue([ROW]);
    const worker = new NhcxReplayWorker(
      stub.integration as never,
      makeConfig({ NHCX_REPLAY_DISABLED: '1' }),
    );
    worker.registerHandler({
      operation: 'eligibility.verify',
      handle: async () => {
        throw new Error('connection reset');
      },
    });
    const result = await worker.runOnce();
    expect(result.reparked).toBe(1);
    expect(stub.markQueuedForRetry).toHaveBeenCalled();
    expect(stub.markReplayExhausted).not.toHaveBeenCalled();
  });

  it('processes multiple rows in a single tick', async () => {
    const stub = makeIntegrationStub();
    stub.findReplayable.mockResolvedValue([
      { ...ROW, id: 'o1' },
      { ...ROW, id: 'o2', operation: 'preauth.submit' },
      { ...ROW, id: 'o3' },
    ]);
    const worker = new NhcxReplayWorker(
      stub.integration as never,
      makeConfig({ NHCX_REPLAY_DISABLED: '1' }),
    );
    worker.registerHandler({
      operation: 'eligibility.verify',
      handle: async () => 'succeeded',
    });
    // No handler for preauth.submit → that one gets skipped.
    const result = await worker.runOnce();
    expect(result).toEqual({
      processed: 2,
      succeeded: 2,
      reparked: 0,
      permanent: 0,
      skipped: 1,
    });
  });
});
