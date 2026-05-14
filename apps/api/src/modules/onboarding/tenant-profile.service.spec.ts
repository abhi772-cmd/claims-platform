// Service-level unit tests for TenantProfileService — the read/write
// path for Stage-1 onboarding fields. The real e2e (tenant-profile.e2e-spec.ts)
// exercises validation + RLS + audit against real Postgres; here we
// focus on:
//   - get() returns the column projection unchanged
//   - get() throws TenantNotFoundError when the row is missing
//   - update() forwards the patch verbatim to prisma.tenant.update
//   - update() writes an audit row with before/after snapshots

import { ErrorCodes } from '@claims/error-codes';

import { TenantProfileService } from './tenant-profile.service';

interface FakePrisma {
  runInTenantContext: jest.Mock;
}

function makePrisma(
  initialRow: Record<string, unknown> | null,
  updatedRow: Record<string, unknown> | null = initialRow,
): { prisma: FakePrisma; tx: { tenant: { findUnique: jest.Mock; update: jest.Mock } } } {
  const tx = {
    tenant: {
      findUnique: jest.fn().mockResolvedValue(initialRow),
      update: jest.fn().mockResolvedValue(updatedRow),
    },
  };
  const prisma: FakePrisma = {
    runInTenantContext: jest.fn(async (_tenantId, _role, cb) => cb(tx)),
  };
  return { prisma, tx };
}

function makeAudit(): { recordWithTx: jest.Mock } {
  return { recordWithTx: jest.fn().mockResolvedValue(undefined) };
}

describe('TenantProfileService', () => {
  const tenantId = '00000000-0000-0000-0000-000000000001';
  const actorUserId = '00000000-0000-0000-0000-0000000000aa';

  it('get() returns the column projection', async () => {
    const row = {
      legalName: 'Apollo Hospitals Indore',
      rohiniId: '123456789',
      hospitalType: 'private',
      bedCount: 250,
      hmisVendor: 'Birlamedisoft',
      expectedMonthlyClaimsBand: 'band_500_2000',
    };
    const { prisma } = makePrisma(row);
    const audit = makeAudit();
    const svc = new TenantProfileService(prisma as never, audit as never);

    const got = await svc.get(tenantId);
    expect(got).toEqual(row);
  });

  it('get() throws TenantNotFoundError when row is missing', async () => {
    const { prisma } = makePrisma(null);
    const audit = makeAudit();
    const svc = new TenantProfileService(prisma as never, audit as never);

    await expect(svc.get(tenantId)).rejects.toMatchObject({
      code: ErrorCodes.TENANT_NOT_FOUND,
    });
  });

  it('update() forwards patch to prisma + writes audit with before/after', async () => {
    const before = {
      legalName: null,
      rohiniId: null,
      hospitalType: null,
      bedCount: null,
      hmisVendor: null,
      expectedMonthlyClaimsBand: null,
    };
    const after = {
      ...before,
      legalName: 'Apollo Hospitals Indore',
      bedCount: 250,
    };
    const { prisma, tx } = makePrisma(before, after);
    const audit = makeAudit();
    const svc = new TenantProfileService(prisma as never, audit as never);

    const result = await svc.update({
      tenantId,
      actorUserId,
      patch: { legalName: 'Apollo Hospitals Indore', bedCount: 250 },
      ip: '203.0.113.10',
      userAgent: 'jest',
    });

    expect(result).toEqual(after);
    expect(tx.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: tenantId },
        data: { legalName: 'Apollo Hospitals Indore', bedCount: 250 },
      }),
    );
    expect(audit.recordWithTx).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'TENANT_UPDATED',
        resourceType: 'tenant_profile',
        resourceId: tenantId,
        before,
        after,
        ipAddress: '203.0.113.10',
      }),
    );
  });

  it('update() throws TenantNotFoundError when row missing pre-update', async () => {
    const { prisma } = makePrisma(null);
    const audit = makeAudit();
    const svc = new TenantProfileService(prisma as never, audit as never);

    await expect(
      svc.update({
        tenantId,
        actorUserId,
        patch: { bedCount: 100 },
        ip: null,
        userAgent: null,
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.TENANT_NOT_FOUND });
  });
});
