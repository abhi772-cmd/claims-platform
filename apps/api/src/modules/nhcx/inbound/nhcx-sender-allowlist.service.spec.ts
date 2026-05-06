// Unit tests for the sender-code allowlist. Mocks PrismaService so we
// don't need testcontainers — the integration tests already cover the
// platform_admin GUC + Payer table read.

import { NhcxSenderAllowlistService } from './nhcx-sender-allowlist.service';

interface FakeTx {
  $executeRaw: jest.Mock;
  payer: { findMany: jest.Mock };
}

function makePrisma(payerRows: { hcxCode: string | null }[]): {
  $transaction: jest.Mock;
} {
  return {
    $transaction: jest.fn(async (cb: (tx: FakeTx) => unknown) => {
      const tx: FakeTx = {
        $executeRaw: jest.fn(),
        payer: { findMany: jest.fn().mockResolvedValue(payerRows) },
      };
      return cb(tx);
    }),
  };
}

describe('NhcxSenderAllowlistService', () => {
  it('allows any sender when the allowlist is empty', async () => {
    const prisma = makePrisma([]);
    const svc = new NhcxSenderAllowlistService(prisma as never);

    expect(await svc.isAllowed('star-health@hcx')).toBe(true);
    expect(await svc.isAllowed(null)).toBe(true);
    expect(await svc.isAllowed('anything@hcx')).toBe(true);
  });

  it('allows known sender + rejects unknown when allowlist is non-empty', async () => {
    const prisma = makePrisma([
      { hcxCode: 'star-health@hcx' },
      { hcxCode: 'paramount@hcx' },
    ]);
    const svc = new NhcxSenderAllowlistService(prisma as never);

    expect(await svc.isAllowed('star-health@hcx')).toBe(true);
    expect(await svc.isAllowed('paramount@hcx')).toBe(true);
    expect(await svc.isAllowed('rogue@hcx')).toBe(false);
  });

  it('rejects missing sender when allowlist is non-empty', async () => {
    const prisma = makePrisma([{ hcxCode: 'star-health@hcx' }]);
    const svc = new NhcxSenderAllowlistService(prisma as never);

    expect(await svc.isAllowed(null)).toBe(false);
  });

  it('caches the read so repeat lookups do not hit the DB', async () => {
    const prisma = makePrisma([{ hcxCode: 'star-health@hcx' }]);
    const svc = new NhcxSenderAllowlistService(prisma as never);

    await svc.isAllowed('star-health@hcx');
    await svc.isAllowed('star-health@hcx');
    await svc.isAllowed('rogue@hcx');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('invalidate forces a re-fetch', async () => {
    const prisma = makePrisma([{ hcxCode: 'star-health@hcx' }]);
    const svc = new NhcxSenderAllowlistService(prisma as never);

    await svc.isAllowed('star-health@hcx');
    svc.invalidate();
    await svc.isAllowed('star-health@hcx');
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('skips rows whose hcxCode is null', async () => {
    const prisma = makePrisma([
      { hcxCode: 'star-health@hcx' },
      { hcxCode: null },
      { hcxCode: 'paramount@hcx' },
    ]);
    const svc = new NhcxSenderAllowlistService(prisma as never);

    expect(await svc.isAllowed('star-health@hcx')).toBe(true);
    expect(await svc.isAllowed('paramount@hcx')).toBe(true);
    expect(await svc.isAllowed('')).toBe(false);
  });
});
