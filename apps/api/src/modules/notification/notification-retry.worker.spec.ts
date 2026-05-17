import type { ConfigService } from '@nestjs/config';

import type { EmailAdapter } from './email.adapter';
import { NotificationRetryWorker, computeNextEligibleAt } from './notification-retry.worker';
import type { SmsAdapter } from './sms.adapter';
import type { PrismaService } from '../../common/prisma/prisma.service';

const SENTINEL = '00000000-0000-0000-0000-000000000000';

describe('NotificationRetryWorker.runOnce — RLS regression', () => {
  function makeDeps() {
    const txFindMany = jest.fn().mockResolvedValue([]);
    const tx = { notificationOutbox: { findMany: txFindMany } };
    const runInTenantContext = jest.fn(
      async (_tenantId: string, _role: string, fn: (tx: unknown) => unknown) =>
        fn(tx),
    );
    // Spy on a direct path too, so the regression catches anyone who
    // reverts to the bypassing form `prisma.notificationOutbox.findMany(...)`.
    const directFindMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      runInTenantContext,
      notificationOutbox: { findMany: directFindMany },
    } as unknown as PrismaService;
    const config = {
      get: (k: string) =>
        k === 'NOTIFICATION_RETRY_DISABLED' ? '1' : undefined,
    } as unknown as ConfigService;
    return {
      prisma,
      runInTenantContext,
      txFindMany,
      directFindMany,
      config,
    };
  }

  it('reads the queue via runInTenantContext(SENTINEL, platform_admin, ...)', async () => {
    const { prisma, runInTenantContext, txFindMany, directFindMany, config } = makeDeps();
    const worker = new NotificationRetryWorker(
      prisma,
      {} as EmailAdapter,
      {} as SmsAdapter,
      config,
    );
    await worker.runOnce();
    expect(directFindMany).not.toHaveBeenCalled();
    expect(runInTenantContext).toHaveBeenCalledTimes(1);
    expect(runInTenantContext.mock.calls[0]?.[0]).toBe(SENTINEL);
    expect(runInTenantContext.mock.calls[0]?.[1]).toBe('platform_admin');
    expect(txFindMany).toHaveBeenCalledTimes(1);
  });
});

describe('computeNextEligibleAt', () => {
  const base = new Date('2026-05-05T12:00:00.000Z');

  it('attempt 0 → eligible immediately', () => {
    expect(computeNextEligibleAt(base, 0).getTime()).toBe(base.getTime());
  });

  it('attempt 1 → +60s', () => {
    expect(computeNextEligibleAt(base, 1).getTime()).toBe(base.getTime() + 60_000);
  });

  it('attempt 2 → +5m', () => {
    expect(computeNextEligibleAt(base, 2).getTime()).toBe(base.getTime() + 5 * 60_000);
  });

  it('attempt 3 → +30m', () => {
    expect(computeNextEligibleAt(base, 3).getTime()).toBe(base.getTime() + 30 * 60_000);
  });

  it('attempt 4 → +2h', () => {
    expect(computeNextEligibleAt(base, 4).getTime()).toBe(base.getTime() + 2 * 60 * 60_000);
  });

  it('attempts beyond the schedule clamp to the last entry', () => {
    expect(computeNextEligibleAt(base, 99).getTime()).toBe(base.getTime() + 2 * 60 * 60_000);
  });
});
