// D-023 — syncPrimaryPackageLine unit tests.
//
// Pure-function helper: mocks the three Prisma delegates it touches
// (package.findUnique, claimLineItem.upsert, claim.update) so we
// exercise the auto-fill / override / validation logic without Postgres.

import { syncPrimaryPackageLine } from './claim-line-item.helpers';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { type TenantPrisma } from '../../types/express';

interface PackageRow {
  code: string;
  name: string;
  amount: number;
  active: boolean;
}

function makeTx(pkg: PackageRow | null) {
  const findUnique = jest.fn().mockResolvedValue(pkg);
  const upsert = jest.fn().mockResolvedValue({});
  const update = jest.fn().mockResolvedValue({});
  const tx = {
    package: { findUnique },
    claimLineItem: { upsert },
    claim: { update },
    // Cast: the helper only touches the three delegates above, so a
    // partial stub is sufficient. Justified narrow assertion.
  } as unknown as TenantPrisma;
  return { tx, findUnique, upsert, update };
}

const CABG: PackageRow = {
  code: 'HBP-CARDIO-001',
  name: 'CABG (Coronary Artery Bypass Grafting)',
  amount: 9_000_000, // ₹90,000 in paise
  active: true,
};

const baseParams = {
  tenantId: 't-1',
  claimId: 'c-1',
  rail: 'pmjay',
  packageCode: CABG.code,
};

describe('syncPrimaryPackageLine', () => {
  it('auto-fills requestedAmount from the package rate when no override', async () => {
    const { tx, upsert, update } = makeTx(CABG);

    const result = await syncPrimaryPackageLine(tx, baseParams);

    expect(result.requestedAmount).toBe(9_000_000);
    expect(result.unitAmount).toBe(9_000_000);
    expect(result.display).toBe(CABG.name);

    // Primary line: sequence 1, lineType package, rail + rate stamped.
    const created = upsert.mock.calls[0][0].create;
    expect(created).toMatchObject({
      sequence: 1,
      lineType: 'package',
      code: CABG.code,
      rail: 'pmjay',
      unitAmount: 9_000_000,
      requestedAmount: 9_000_000,
      lineStatus: 'requested',
    });

    // Denormalised onto the claim.
    expect(update).toHaveBeenCalledWith({
      where: { id: 'c-1' },
      data: { packageCode: CABG.code },
    });
  });

  it('honours a positive operator override (enhancement / implant)', async () => {
    const { tx, upsert } = makeTx(CABG);

    const result = await syncPrimaryPackageLine(tx, {
      ...baseParams,
      requestedAmountOverride: 9_500_000, // operator asked for more
    });

    expect(result.requestedAmount).toBe(9_500_000);
    // unitAmount stays the package rate; only requestedAmount moves.
    expect(result.unitAmount).toBe(9_000_000);
    expect(upsert.mock.calls[0][0].create.requestedAmount).toBe(9_500_000);
  });

  it('ignores a non-positive override and falls back to the rate', async () => {
    const { tx } = makeTx(CABG);

    const result = await syncPrimaryPackageLine(tx, {
      ...baseParams,
      requestedAmountOverride: 0,
    });

    expect(result.requestedAmount).toBe(9_000_000);
  });

  it('upserts on the (claimId, sequence) key so re-picking replaces the line', async () => {
    const { tx, upsert } = makeTx(CABG);

    await syncPrimaryPackageLine(tx, baseParams);

    expect(upsert.mock.calls[0][0].where).toEqual({
      claimId_sequence: { claimId: 'c-1', sequence: 1 },
    });
  });

  it('throws ValidationFailedError for an unknown package', async () => {
    const { tx, upsert, update } = makeTx(null);

    await expect(syncPrimaryPackageLine(tx, baseParams)).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    expect(upsert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('throws ValidationFailedError for an inactive package', async () => {
    const { tx } = makeTx({ ...CABG, active: false });

    await expect(syncPrimaryPackageLine(tx, baseParams)).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });
});
