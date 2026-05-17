// T2-13 follow-up — BillLineItemService unit tests.
//
// Mocks PrismaService.runInTenantContext + AuditService so we
// exercise the replace-all composition logic + the toListResponse
// totals math without standing up Postgres.

import { BillLineItemService } from './bill-line-item.service';

type Row = {
  id: string;
  description: string;
  amountPaise: number;
  medical: boolean;
  category: string | null;
  matchedTerm: string | null;
  createdAt: Date;
};

function makePrismaStub() {
  let stored: Row[] = [];
  const deleteMany = jest.fn().mockImplementation(({ where }: { where: { claimId: string } }) => {
    void where;
    const count = stored.length;
    stored = [];
    return Promise.resolve({ count });
  });
  const createMany = jest
    .fn()
    .mockImplementation(({ data }: { data: Array<Omit<Row, 'id' | 'createdAt'> & { tenantId: string; claimId: string; createdById: string }> }) => {
      const now = new Date('2026-05-17T08:00:00.000Z');
      for (const d of data) {
        stored.push({
          id: 'row-' + (stored.length + 1),
          description: d.description,
          amountPaise: d.amountPaise,
          medical: d.medical,
          category: d.category,
          matchedTerm: d.matchedTerm,
          createdAt: now,
        });
      }
      return Promise.resolve({ count: data.length });
    });
  const findMany = jest.fn().mockImplementation(() => Promise.resolve(stored.slice()));
  const tx = { billLineItem: { deleteMany, createMany, findMany } };
  const prisma = {
    runInTenantContext: jest
      .fn()
      .mockImplementation((_tenantId: string, _role: string, cb: (tx: unknown) => unknown) =>
        Promise.resolve(cb(tx)),
      ),
  };
  return { prisma, deleteMany, createMany, findMany, getStored: () => stored };
}

function makeAuditStub() {
  const recordWithTx = jest.fn().mockResolvedValue(undefined);
  return { audit: { recordWithTx } as unknown, recordWithTx };
}

describe('BillLineItemService.replaceForClaim', () => {
  it('inserts the new line set and returns totals', async () => {
    const { prisma } = makePrismaStub();
    const { audit } = makeAuditStub();
    const svc = new BillLineItemService(prisma as never, audit as never);
    const out = await svc.replaceForClaim({
      tenantId: 'tenant-1',
      claimId: 'claim-1',
      actorUserId: 'user-1',
      lines: [
        { description: 'Surgery', amountPaise: 5_000_000, medical: true },
        {
          description: 'Toiletry kit',
          amountPaise: 30_000,
          medical: false,
          category: 'toiletries',
          matchedTerm: 'Toiletry',
        },
      ],
    });
    expect(out.lines).toHaveLength(2);
    expect(out.totals).toEqual({
      medicalPaise: 5_000_000,
      nonMedicalPaise: 30_000,
      grandTotalPaise: 5_030_000,
    });
  });

  it('clears persisted rows when saving an empty set', async () => {
    const { prisma, getStored } = makePrismaStub();
    const { audit } = makeAuditStub();
    const svc = new BillLineItemService(prisma as never, audit as never);

    await svc.replaceForClaim({
      tenantId: 'tenant-1',
      claimId: 'claim-1',
      actorUserId: 'user-1',
      lines: [{ description: 'Surgery', amountPaise: 5_000_000, medical: true }],
    });
    expect(getStored()).toHaveLength(1);

    const out = await svc.replaceForClaim({
      tenantId: 'tenant-1',
      claimId: 'claim-1',
      actorUserId: 'user-1',
      lines: [],
    });
    expect(out.lines).toEqual([]);
    expect(out.totals).toEqual({
      medicalPaise: 0,
      nonMedicalPaise: 0,
      grandTotalPaise: 0,
    });
    expect(getStored()).toEqual([]);
  });

  it('forces medical=true rows to null category + matchedTerm even if supplied', async () => {
    const { prisma, getStored } = makePrismaStub();
    const { audit } = makeAuditStub();
    const svc = new BillLineItemService(prisma as never, audit as never);
    await svc.replaceForClaim({
      tenantId: 'tenant-1',
      claimId: 'claim-1',
      actorUserId: 'user-1',
      lines: [
        {
          description: 'Surgery',
          amountPaise: 5_000_000,
          medical: true,
          // Operator-or-classifier-supplied non-null values for a
          // medical row. Service must scrub these on write.
          category: 'toiletries',
          matchedTerm: 'soap',
        },
      ],
    });
    const row = getStored()[0]!;
    expect(row.medical).toBe(true);
    expect(row.category).toBeNull();
    expect(row.matchedTerm).toBeNull();
  });

  it('writes one audit row per save with bounded snapshot (count + totals only)', async () => {
    const { prisma } = makePrismaStub();
    const { audit, recordWithTx } = makeAuditStub();
    const svc = new BillLineItemService(prisma as never, audit as never);
    await svc.replaceForClaim({
      tenantId: 'tenant-1',
      claimId: 'claim-1',
      actorUserId: 'user-1',
      lines: [
        { description: 'Surgery', amountPaise: 5_000_000, medical: true },
        {
          description: 'TV rental',
          amountPaise: 20_000,
          medical: false,
          category: 'comfort',
          matchedTerm: 'TV rental',
        },
      ],
    });
    expect(recordWithTx).toHaveBeenCalledTimes(1);
    const call = recordWithTx.mock.calls[0]?.[1] as {
      resourceType: string;
      after: { lineCount: number; grandTotalPaise: number; nonMedicalPaise: number };
    };
    expect(call.resourceType).toBe('bill_line_item');
    expect(call.after).toEqual({
      lineCount: 2,
      grandTotalPaise: 5_020_000,
      nonMedicalPaise: 20_000,
    });
  });
});

describe('BillLineItemService.listForClaim', () => {
  it('returns empty state for a claim with no saved lines', async () => {
    const { prisma } = makePrismaStub();
    const { audit } = makeAuditStub();
    const svc = new BillLineItemService(prisma as never, audit as never);
    const out = await svc.listForClaim('tenant-1', 'claim-99');
    expect(out.lines).toEqual([]);
    expect(out.totals).toEqual({
      medicalPaise: 0,
      nonMedicalPaise: 0,
      grandTotalPaise: 0,
    });
  });

  it('round-trips saved lines through list (medical + non-medical mixed)', async () => {
    const { prisma } = makePrismaStub();
    const { audit } = makeAuditStub();
    const svc = new BillLineItemService(prisma as never, audit as never);
    await svc.replaceForClaim({
      tenantId: 'tenant-1',
      claimId: 'claim-1',
      actorUserId: 'user-1',
      lines: [
        { description: 'Surgery', amountPaise: 5_000_000, medical: true },
        {
          description: 'Attendant food',
          amountPaise: 80_000,
          medical: false,
          category: 'attendant_food',
          matchedTerm: 'Attendant food',
        },
      ],
    });
    const out = await svc.listForClaim('tenant-1', 'claim-1');
    expect(out.lines.map((l) => l.description)).toEqual(['Surgery', 'Attendant food']);
    expect(out.totals.medicalPaise).toBe(5_000_000);
    expect(out.totals.nonMedicalPaise).toBe(80_000);
  });
});
